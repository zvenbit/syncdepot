import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { databaseMode as defaultDatabaseMode, query as defaultQuery, pool as defaultPool, transaction as defaultTransaction } from './db.js';
import { hashPassword, newApiKey, optionalJson, requiredString, sha256, signToken, verifyPassword, verifyToken, type TokenPayload } from './lib.js';
import { bearer, createGameGuard, createUserGuard, GAME_SCOPES, rateLimit, type GameAccess, type UserAccess } from './access.js';
import { writeAudit } from './audit.js';
import { openApiDocument } from './openapi.js';
import { excelWorkbookToConfigs, MAX_EXCEL_FILE_BYTES } from './excel.js';
import { createConfigModule } from './modules/config.js';
import { createArchiveSyncModule } from './modules/archive.js';
import { createIdentityModule, createWebhookCredentialVerifier, type PlatformCredentialVerifier } from './modules/identity.js';
import { createGameAccessModule } from './modules/game-access.js';
import { createAnalyticsModule, type AnalyticsEvent } from './modules/analytics.js';
import { createMetricsCollector } from './metrics.js';
import { startRetentionScheduler } from './maintenance.js';
import { createDatabaseRateLimitStore, createMemoryRateLimitStore } from './rate-limit.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: TokenPayload;
    game?: GameAccess;
    userAccess?: UserAccess;
    startedAt?: number;
  }
}

type JsonObject = Record<string, unknown>;
type AppError = Error & { statusCode?: number; code?: string; detail?: string; current?: unknown };
type AdminRow = { id: string; username: string; password_hash: string; role: 'admin' | 'viewer' };
type ArchiveRow = { id: string; game_id: string; user_id: string; slot: string; data: unknown; version: number; updated_at: string };

export type AppDependencies = {
  query: typeof defaultQuery;
  transaction: typeof defaultTransaction;
  pool: typeof defaultPool;
  databaseMode: typeof defaultDatabaseMode;
  identityVerifier?: PlatformCredentialVerifier;
  env?: NodeJS.ProcessEnv;
};

export function createApp(dependencies: Partial<AppDependencies> = {}) {
const databaseOverrides = [dependencies.query, dependencies.transaction, dependencies.pool, dependencies.databaseMode];
if (databaseOverrides.some(Boolean) && !databaseOverrides.every(Boolean)) {
  throw new Error('注入数据库时必须同时提供 query、transaction、pool 和 databaseMode');
}
const query = dependencies.query || defaultQuery;
const transaction = dependencies.transaction || defaultTransaction;
const pool = dependencies.pool || defaultPool;
const databaseMode = dependencies.databaseMode || defaultDatabaseMode;
const env = dependencies.env || process.env;
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const JWT_SECRET = env.JWT_SECRET || 'development-only-secret-change-me';
const ARCHIVE_LIMIT = Number(env.ARCHIVE_SIZE_LIMIT || 262144);
const app = Fastify({ logger: env.NODE_ENV === 'test' ? false : true, bodyLimit: Number(env.BODY_LIMIT || 1048576), trustProxy: env.TRUST_PROXY === 'true' });
const moduleDatabase = { query, transaction };
const configModule = createConfigModule(moduleDatabase);
const archiveModule = createArchiveSyncModule(moduleDatabase, { maxBytes: ARCHIVE_LIMIT });
const gameAccessModule = createGameAccessModule(moduleDatabase);
const analyticsModule = createAnalyticsModule(moduleDatabase);
const metrics = createMetricsCollector({ query, flushMs: Number(env.METRICS_FLUSH_MS || 1000) });
let retentionScheduler: { close(): void } | null = null;
const unavailableVerifier: PlatformCredentialVerifier = {
  async verify() { throw fail(503, '尚未配置 PLATFORM_IDENTITY_WEBHOOK_URL'); },
};
const identityVerifier = dependencies.identityVerifier || (env.PLATFORM_IDENTITY_WEBHOOK_URL
  ? createWebhookCredentialVerifier({
      url: env.PLATFORM_IDENTITY_WEBHOOK_URL,
      ...(env.PLATFORM_IDENTITY_WEBHOOK_SECRET ? { secret: env.PLATFORM_IDENTITY_WEBHOOK_SECRET } : {}),
    })
  : unavailableVerifier);
const identityModule = createIdentityModule(moduleDatabase, {
  verifier: identityVerifier,
  signUserToken: payload => signToken(payload, JWT_SECRET, 2 * 3600),
});
const rateLimitStore = env.RATE_LIMIT_STORE === 'database' ? createDatabaseRateLimitStore(query) : createMemoryRateLimitStore();

const fail = (statusCode: number, message: string): AppError => Object.assign(new Error(message), { statusCode });
const body = (request: FastifyRequest): JsonObject => (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}) as JsonObject;
const routeParams = (request: FastifyRequest): Record<string, string> => request.params as Record<string, string>;
const searchParams = (request: FastifyRequest): Record<string, string | undefined> => request.query as Record<string, string | undefined>;
const currentGame = (request: FastifyRequest): GameAccess => request.game || (() => { throw fail(401, '游戏凭证无效'); })();
const asString = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const cookie = (request: FastifyRequest, name: string): string | undefined => request.headers.cookie
  ?.split(';')
  .map(value => value.trim().split('='))
  .find(([key]) => key === name)?.[1];

async function requireAdmin(request: FastifyRequest): Promise<void> {
  const payload = verifyToken(bearer(request) || cookie(request, 'admin_session'), JWT_SECRET);
  if (!payload?.sub || (payload.role !== 'admin' && payload.role !== 'viewer')) throw fail(401, '管理员登录已失效');
  request.admin = payload;
}

async function requireAdminWrite(request: FastifyRequest): Promise<void> {
  await requireAdmin(request);
  if (request.admin?.role !== 'admin') throw fail(403, '只读账号不能执行该操作');
}

function createAdminGameGuard(permission: 'read' | 'write' | 'owner', resolveGameId: (request: FastifyRequest) => Promise<string | undefined> | string | undefined) {
  return async (request: FastifyRequest): Promise<void> => {
    await requireAdmin(request);
    const gameId = await resolveGameId(request);
    if (!gameId) throw fail(404, '游戏或资源不存在');
    await gameAccessModule.assert({
      adminId: request.admin!.sub,
      globalRole: request.admin!.role!,
      gameId,
      permission,
    });
  };
}

const gameParam = (request: FastifyRequest) => routeParams(request).id;
const resourceGame = (table: 'game_api_keys' | 'game_configs' | 'game_users' | 'user_archives' | 'game_event_definitions') => async (request: FastifyRequest) => {
  const row = (await query<{ game_id: string }>(`SELECT game_id FROM ${table} WHERE id=$1`, [routeParams(request).id])).rows[0];
  return row?.game_id;
};
const gameRead = createAdminGameGuard('read', gameParam);
const gameWrite = createAdminGameGuard('write', gameParam);
const gameOwner = createAdminGameGuard('owner', gameParam);
const keyOwner = createAdminGameGuard('owner', resourceGame('game_api_keys'));
const configReadAdmin = createAdminGameGuard('read', resourceGame('game_configs'));
const configWriteAdmin = createAdminGameGuard('write', resourceGame('game_configs'));
const userReadAdmin = createAdminGameGuard('read', resourceGame('game_users'));
const archiveReadAdmin = createAdminGameGuard('read', resourceGame('user_archives'));
const archiveWriteAdmin = createAdminGameGuard('write', resourceGame('user_archives'));
const eventDefinitionWrite = createAdminGameGuard('write', resourceGame('game_event_definitions'));

const configRead = createGameGuard('config:read', query);
const userResolve = createGameGuard('user:resolve', query);
const archiveRead = createGameGuard('archive:read', query);
const archiveWrite = createGameGuard('archive:write', query);
const analyticsWrite = createGameGuard('analytics:write', query);
const requireUser = createUserGuard(JWT_SECRET, query);
const loginLimit = rateLimit({ limit: 10, windowMs: 60_000 }, rateLimitStore);
const sessionLimit = rateLimit({ limit: 30, windowMs: 60_000 }, rateLimitStore);
const clientReadLimit = rateLimit({ limit: 300, windowMs: 60_000, key: request => `${request.ip}:${request.game?.id || request.userAccess?.game_id || ''}` }, rateLimitStore);
const clientWriteLimit = rateLimit({ limit: 60, windowMs: 60_000, key: request => `${request.ip}:${request.game?.id || request.userAccess?.game_id || ''}` }, rateLimitStore);

const loginSchema = { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', minLength: 1, maxLength: 64 }, password: { type: 'string', minLength: 1, maxLength: 256 } } } } as const;
const gameSchema = { body: { type: 'object', additionalProperties: false, required: ['game_key', 'name'], properties: { game_key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }, name: { type: 'string', minLength: 1, maxLength: 128 }, description: { type: 'string', maxLength: 2000 } } } } as const;
const resolveSchema = { body: { type: 'object', additionalProperties: false, anyOf: [{ required: ['openid'] }, { required: ['user_id'] }], properties: { openid: { type: 'string', minLength: 1, maxLength: 191 }, user_id: { type: 'string', minLength: 1, maxLength: 191 }, profile: { type: 'object' } } } } as const;
const archiveSchema = { body: { type: 'object', additionalProperties: false, required: ['data'], properties: { data: {}, version: { type: 'integer', minimum: 1 } } } } as const;
const eventsSchema = {
  body: {
    type: 'object', additionalProperties: false, required: ['events'],
    properties: {
      events: {
        type: 'array', minItems: 1, maxItems: 100,
        items: {
          type: 'object', additionalProperties: false, required: ['event_key'],
          properties: {
            event_key: { type: 'string', minLength: 2, maxLength: 96 },
            user_id: { type: 'string', minLength: 1, maxLength: 191 },
            session_id: { type: 'string', minLength: 1, maxLength: 191 },
            properties: {},
            occurred_at: { type: 'string', minLength: 1, maxLength: 64 },
            idempotency_key: { type: 'string', minLength: 1, maxLength: 191 },
          },
        },
      },
    },
  },
} as const;

function analyticsEvents(value: unknown, userId?: string): AnalyticsEvent[] {
  if (!Array.isArray(value)) throw fail(400, 'events 必须是数组');
  return value.map(item => {
    const event = item && typeof item === 'object' && !Array.isArray(item) ? item as JsonObject : {};
    return {
      eventKey: requiredString(event.event_key, 'event_key', 96),
      ...(userId ? { userId } : typeof event.user_id === 'string' ? { userId: event.user_id } : {}),
      ...(typeof event.session_id === 'string' ? { sessionId: event.session_id } : {}),
      ...(event.properties !== undefined ? { properties: event.properties } : {}),
      ...(typeof event.occurred_at === 'string' ? { occurredAt: event.occurred_at } : {}),
      ...(typeof event.idempotency_key === 'string' ? { idempotencyKey: event.idempotency_key } : {}),
    };
  });
}

app.addHook('onRequest', async request => { request.startedAt = Date.now(); });
app.addHook('preValidation', async request => {
  if (!request.url.startsWith('/api/admin/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || bearer(request) || !cookie(request, 'admin_session')) return;
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== request.headers.host) throw fail(403, '跨站管理请求已拒绝');
    } catch (error) {
      if ((error as AppError).statusCode === 403) throw error;
      throw fail(403, '跨站管理请求已拒绝');
    }
  }
});
app.addHook('onSend', async (_request, reply, payload) => {
  reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    .header('Referrer-Policy', 'no-referrer')
    .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return payload;
});
app.addHook('onClose', async () => { await metrics.close(); });
app.addHook('onResponse', async (request, reply) => {
  const gameId = request.game?.id || request.userAccess?.game_id;
  if (!gameId || !request.url.startsWith('/api/client/')) return;
  const route = request.routeOptions.url || request.url.split('?')[0]!;
  const duration = Date.now() - (request.startedAt || Date.now());
  metrics.record({ gameId, route, statusCode: reply.statusCode, durationMs: duration });
});

app.setErrorHandler((error: AppError, _request, reply) => {
  if (error.code === '23505') return reply.code(409).send({ error: '数据已存在', detail: error.detail });
  if (error.code === '23503') return reply.code(400).send({ error: '关联数据不存在' });
  const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
  if (status === 500) app.log.error(error);
  reply.code(status).send({ error: status === 500 ? '服务器内部错误' : error.message, ...(error.current !== undefined ? { current: error.current } : {}) });
});

app.get('/health', async () => { await query('SELECT 1'); return { ok: true, database: databaseMode, time: new Date().toISOString() }; });
app.get('/openapi.json', async () => openApiDocument);
app.get('/sdk/game-client.ts', async (_request, reply) => reply.type('text/plain; charset=utf-8').send(await fs.readFile(path.resolve('sdk/game-client.ts'), 'utf8')));

app.post('/api/admin/login', { schema: loginSchema, preHandler: loginLimit }, async (request, reply) => {
  const b = body(request);
  const username = requiredString(b.username, 'username', 64);
  const result = await query<AdminRow>('SELECT id,username,password_hash,role FROM admins WHERE username=$1', [username]);
  const admin = result.rows[0];
  if (!admin || !verifyPassword(asString(b.password), admin.password_hash)) throw fail(401, '用户名或密码错误');
  const token = signToken({ sub: admin.id, username: admin.username, role: admin.role }, JWT_SECRET);
  reply.header('Set-Cookie', `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return { token, user: { username: admin.username, role: admin.role } };
});

app.post('/api/admin/logout', async (_request, reply) => {
  reply.header('Set-Cookie', `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  return { logged_out: true };
});

app.get('/api/admin/admins', { preHandler: requireAdmin }, async () =>
  (await query('SELECT id,username,role,created_at,updated_at FROM admins ORDER BY created_at')).rows);

app.post('/api/admin/admins', { preHandler: requireAdminWrite }, async request => {
  const b = body(request);
  const password = requiredString(b.password, 'password', 256);
  if (password.length < 10) throw fail(400, '密码必须至少 10 位');
  const role = b.role === 'viewer' ? 'viewer' : 'admin';
  return transaction(async client => {
    const result = await client.query('INSERT INTO admins(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role,created_at', [requiredString(b.username, 'username', 64), hashPassword(password), role]);
    await writeAudit({ request, action: 'admin.create', resourceType: 'admin', resourceId: String(result.rows[0]!.id), after: result.rows[0] }, client);
    return result.rows[0];
  });
});

app.patch('/api/admin/admins/:id', { preHandler: requireAdminWrite }, async request => {
  const id = routeParams(request).id!;
  const b = body(request);
  const passwordHash = typeof b.password === 'string' && b.password.length >= 10 ? hashPassword(b.password) : null;
  const role = b.role === 'admin' || b.role === 'viewer' ? b.role : null;
  return transaction(async client => {
    const before = (await client.query('SELECT id,username,role FROM admins WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!before) throw fail(404, '管理员不存在');
    if (before.role === 'admin' && role === 'viewer') {
      const adminCount = Number((await client.query(`SELECT count(*)::int count FROM admins WHERE role='admin'`)).rows[0]?.count || 0);
      if (adminCount <= 1) throw fail(409, '不能将最后一个管理员改为只读账号');
    }
    const result = await client.query('UPDATE admins SET role=COALESCE($2,role),password_hash=COALESCE($3,password_hash),updated_at=now() WHERE id=$1 RETURNING id,username,role,updated_at', [id, role, passwordHash]);
    await writeAudit({ request, action: 'admin.update', resourceType: 'admin', resourceId: id, before, after: result.rows[0] }, client);
    return result.rows[0];
  });
});

app.get('/api/admin/audit-logs', { preHandler: requireAdmin }, async request => {
  const limit = Math.min(Number(searchParams(request).limit) || 100, 500);
  const visible = await gameAccessModule.visibleGameIds(request.admin!.sub, request.admin!.role!);
  return (await query(`SELECT l.*,a.username admin_name,g.name game_name FROM audit_logs l
    LEFT JOIN admins a ON a.id=l.admin_id LEFT JOIN games g ON g.id=l.game_id
    WHERE ($2::uuid[] IS NULL OR l.game_id=ANY($2)) ORDER BY l.created_at DESC LIMIT $1`, [limit, visible])).rows;
});

app.get('/api/admin/games', { preHandler: requireAdmin }, async request => {
  const visible = await gameAccessModule.visibleGameIds(request.admin!.sub, request.admin!.role!);
  return (await query(`SELECT g.id,g.game_key,g.name,g.description,g.enabled,g.settings,g.created_at,g.updated_at,
    (SELECT count(*)::int FROM game_users u WHERE u.game_id=g.id) user_count,
    (SELECT count(*)::int FROM game_configs c WHERE c.game_id=g.id) config_count
    FROM games g WHERE ($1::uuid[] IS NULL OR g.id=ANY($1)) ORDER BY g.created_at DESC`, [visible])).rows;
});

app.post('/api/admin/games', { schema: gameSchema, preHandler: requireAdminWrite }, async request => {
  const apiKey = newApiKey();
  const b = body(request);
  const created = await transaction(async client => {
    const gameResult = await client.query(`INSERT INTO games(game_key,name,description,api_key_hash) VALUES($1,$2,$3,$4)
      RETURNING id,game_key,name,description,enabled,created_at`, [requiredString(b.game_key, 'game_key', 64), requiredString(b.name, 'name', 128), asString(b.description), sha256(apiKey)]);
    const game = gameResult.rows[0]!;
    await client.query(`INSERT INTO game_api_keys(game_id,name,key_hash,scopes) VALUES($1,'初始服务端密钥',$2,$3)`, [game.id, sha256(apiKey), [...GAME_SCOPES]]);
    await client.query(`INSERT INTO game_memberships(game_id,admin_id,role) VALUES($1,$2,'owner') ON CONFLICT(game_id,admin_id) DO UPDATE SET role='owner'`, [game.id, request.admin!.sub]);
    await writeAudit({ request, gameId: String(game.id), action: 'game.create', resourceType: 'game', resourceId: String(game.id), after: game }, client);
    return game;
  });
  return { ...created, api_key: apiKey, scopes: GAME_SCOPES, warning: 'API Key 仅本次显示，请立即妥善保存' };
});

app.patch('/api/admin/games/:id', { preHandler: gameWrite }, async request => {
  const id = routeParams(request).id!;
  const b = body(request);
  return transaction(async client => {
    const before = (await client.query('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const result = await client.query(`UPDATE games SET name=COALESCE($2,name),description=COALESCE($3,description),enabled=COALESCE($4,enabled),settings=COALESCE($5,settings),updated_at=now()
      WHERE id=$1 RETURNING id,game_key,name,description,enabled,settings,updated_at`, [id, b.name, b.description, b.enabled, b.settings]);
    if (!result.rowCount) throw fail(404, '游戏不存在');
    await writeAudit({ request, gameId: id, action: 'game.update', resourceType: 'game', resourceId: id, before, after: result.rows[0] }, client);
    return result.rows[0];
  });
});

app.delete('/api/admin/games/:id', { preHandler: gameOwner }, async request => {
  const id = routeParams(request).id!;
  if (searchParams(request).confirm !== 'DELETE') throw fail(400, '删除游戏会级联删除配置和存档，请传 confirm=DELETE');
  await transaction(async client => {
    const before = (await client.query('SELECT * FROM games WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!before) throw fail(404, '游戏不存在');
    await writeAudit({ request, gameId: id, action: 'game.delete', resourceType: 'game', resourceId: id, before }, client);
    await client.query('DELETE FROM games WHERE id=$1', [id]);
  });
  return { deleted: true };
});

app.get('/api/admin/games/:id/keys', { preHandler: gameRead }, async request =>
  (await query(`SELECT id,name,scopes,enabled,expires_at,last_used_at,last_ip,created_at FROM game_api_keys WHERE game_id=$1 ORDER BY created_at DESC`, [routeParams(request).id])).rows);

app.get('/api/admin/games/:id/members', { preHandler: gameRead }, async request =>
  (await query(`SELECT m.admin_id,a.username,m.role,m.created_at FROM game_memberships m
    JOIN admins a ON a.id=m.admin_id WHERE m.game_id=$1 ORDER BY m.created_at`, [routeParams(request).id])).rows);

app.put('/api/admin/games/:id/members/:adminId', { preHandler: requireAdminWrite }, async request => {
  const role = body(request).role;
  if (role !== 'viewer' && role !== 'editor' && role !== 'owner') throw fail(400, 'role 必须是 viewer、editor 或 owner');
  const p = routeParams(request);
  return transaction(async client => {
    const result = await client.query(`INSERT INTO game_memberships(game_id,admin_id,role) VALUES($1,$2,$3)
      ON CONFLICT(game_id,admin_id) DO UPDATE SET role=excluded.role RETURNING *`, [p.id, p.adminId, role]);
    await writeAudit({ request, gameId: p.id!, action: 'game.member.update', resourceType: 'game_membership', resourceId: p.adminId!, after: result.rows[0] }, client);
    return result.rows[0];
  });
});

app.delete('/api/admin/games/:id/members/:adminId', { preHandler: requireAdminWrite }, async request => {
  const p = routeParams(request);
  await transaction(async client => {
    const result = await client.query('DELETE FROM game_memberships WHERE game_id=$1 AND admin_id=$2 RETURNING *', [p.id, p.adminId]);
    if (!result.rowCount) throw fail(404, '游戏成员不存在');
    await writeAudit({ request, gameId: p.id!, action: 'game.member.delete', resourceType: 'game_membership', resourceId: p.adminId!, before: result.rows[0] }, client);
  });
  return { deleted: true };
});

app.post('/api/admin/games/:id/keys', { preHandler: gameOwner }, async request => {
  const gameId = routeParams(request).id!;
  const b = body(request);
  const scopes = Array.isArray(b.scopes) ? b.scopes.filter((scope): scope is string => typeof scope === 'string' && GAME_SCOPES.includes(scope as typeof GAME_SCOPES[number])) : ['config:read'];
  if (!scopes.length) throw fail(400, '至少选择一个有效权限');
  const apiKey = newApiKey();
  const created = await transaction(async client => {
    const result = await client.query(`INSERT INTO game_api_keys(game_id,name,key_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5) RETURNING id,name,scopes,expires_at,created_at`,
      [gameId, requiredString(b.name, 'name', 128), sha256(apiKey), scopes, b.expires_at || null]);
    await writeAudit({ request, gameId, action: 'api_key.create', resourceType: 'api_key', resourceId: String(result.rows[0]!.id), after: result.rows[0] }, client);
    return result.rows[0];
  });
  return { ...created, api_key: apiKey, warning: '密钥仅本次显示' };
});

app.patch('/api/admin/keys/:id', { preHandler: keyOwner }, async request => {
  const id = routeParams(request).id!;
  const b = body(request);
  return transaction(async client => {
    const before = (await client.query('SELECT * FROM game_api_keys WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const result = await client.query('UPDATE game_api_keys SET enabled=COALESCE($2,enabled),name=COALESCE($3,name) WHERE id=$1 RETURNING id,game_id,name,scopes,enabled,expires_at,last_used_at', [id, b.enabled, b.name]);
    if (!result.rowCount) throw fail(404, 'API Key 不存在');
    await writeAudit({ request, gameId: String(result.rows[0]!.game_id), action: 'api_key.update', resourceType: 'api_key', resourceId: id, before, after: result.rows[0] }, client);
    return result.rows[0];
  });
});

app.post('/api/admin/games/:id/rotate-key', { preHandler: gameOwner }, async request => {
  const gameId = routeParams(request).id!;
  const apiKey = newApiKey();
  const result = await transaction(async client => {
    if (!(await client.query('SELECT 1 FROM games WHERE id=$1 FOR UPDATE', [gameId])).rowCount) throw fail(404, '游戏不存在');
    await client.query('UPDATE game_api_keys SET enabled=false WHERE game_id=$1', [gameId]);
    const created = (await client.query(`INSERT INTO game_api_keys(game_id,name,key_hash,scopes) VALUES($1,'轮换密钥',$2,$3) RETURNING id,game_id,name,scopes`, [gameId, sha256(apiKey), [...GAME_SCOPES]])).rows[0];
    if (!created) throw fail(404, '游戏不存在');
    await writeAudit({ request, gameId, action: 'api_key.rotate', resourceType: 'api_key', resourceId: String(created.id), after: created }, client);
    return created;
  });
  return { ...result, api_key: apiKey, warning: '旧 Key 已立即失效，新 Key 仅本次显示' };
});

app.get('/api/admin/games/:id/configs', { preHandler: gameRead }, async request =>
  (await query('SELECT * FROM game_configs WHERE game_id=$1 ORDER BY environment,config_key', [routeParams(request).id])).rows);

app.post('/api/admin/excel/convert', { bodyLimit: 8 * 1024 * 1024, preHandler: requireAdmin }, async request => {
  const b = body(request);
  const filename = requiredString(b.filename, 'filename', 255);
  if (!/\.xlsx?$/i.test(filename)) throw fail(400, '仅支持 .xls 或 .xlsx Excel 文件');
  const fileBase64 = requiredString(b.file_base64, 'file_base64', Math.ceil(MAX_EXCEL_FILE_BYTES * 4 / 3) + 4);
  if (fileBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileBase64)) throw fail(400, 'Excel 文件编码无效');

  try {
    return { filename, sheets: await excelWorkbookToConfigs(Buffer.from(fileBase64, 'base64')) };
  } catch (error) {
    throw fail(400, `Excel 解析失败：${error instanceof Error ? error.message : '文件格式无效'}`);
  }
});

app.post('/api/admin/games/:id/configs', { preHandler: gameWrite }, async request => {
  const gameId = routeParams(request).id!;
  const b = body(request);
  return configModule.create({
    gameId,
    configKey: requiredString(b.config_key, 'config_key', 128),
    environment: asString(b.environment, 'production'),
    value: optionalJson(b.value),
    ...(b.schema !== undefined ? { schema: b.schema } : {}),
    description: asString(b.description),
    note: asString(b.note, '首次发布'),
    adminId: request.admin!.sub,
    ip: request.ip,
  });
});

app.put('/api/admin/configs/:id', { preHandler: configWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  const b = body(request);
  const published = await configModule.publishValue({
    configId: id,
    value: optionalJson(b.value),
    ...(b.schema !== undefined ? { schema: b.schema } : {}),
    note: asString(b.note, '直接发布'),
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
    adminId: request.admin!.sub,
    ip: request.ip,
  });
  return published;
});

app.post('/api/admin/configs/:id/drafts', { preHandler: configWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  const b = body(request);
  return configModule.createDraft({
    configId: id,
    value: b.value,
    ...(b.schema !== undefined ? { schema: b.schema } : {}),
    note: asString(b.note),
    adminId: request.admin!.sub,
    ip: request.ip,
  });
});

app.get('/api/admin/configs/:id/history', { preHandler: configReadAdmin }, async request => {
  const rows = (await query(`SELECT r.*,r.version revision,a.username created_by_name
    FROM config_revisions r LEFT JOIN admins a ON a.id=r.created_by WHERE config_id=$1 ORDER BY r.version DESC`, [routeParams(request).id])).rows;
  return rows.map(row => ({ ...row, version: row.release_version ?? row.version }));
});

app.put('/api/admin/configs/:id/schema', { preHandler: configWriteAdmin }, async request =>
  configModule.setSchema({
    configId: routeParams(request).id!,
    schema: body(request).schema,
    adminId: request.admin!.sub,
    ip: request.ip,
  }));

function shallowDiff(from: unknown, to: unknown): JsonObject {
  const a = from && typeof from === 'object' && !Array.isArray(from) ? from as JsonObject : {};
  const b = to && typeof to === 'object' && !Array.isArray(to) ? to as JsonObject : {};
  const added: JsonObject = {}, removed: JsonObject = {}, changed: JsonObject = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(key in a)) added[key] = b[key];
    else if (!(key in b)) removed[key] = a[key];
    else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed[key] = { from: a[key], to: b[key] };
  }
  return { added, removed, changed };
}

app.get('/api/admin/configs/:id/diff', { preHandler: configReadAdmin }, async request => {
  const q = searchParams(request);
  const rows = (await query('SELECT release_version version,value FROM config_revisions WHERE config_id=$1 AND release_version IN ($2,$3)', [routeParams(request).id, Number(q.from), Number(q.to)])).rows;
  const from = rows.find(row => Number(row.version) === Number(q.from));
  const to = rows.find(row => Number(row.version) === Number(q.to));
  if (!from || !to) throw fail(404, '对比版本不存在');
  return { from: from.version, to: to.version, diff: shallowDiff(from.value, to.value) };
});

app.post('/api/admin/configs/:id/publish', { preHandler: configWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  const revisionId = requiredString(body(request).revision_id, 'revision_id', 64);
  return configModule.publishDraft({ configId: id, revisionId, adminId: request.admin!.sub, ip: request.ip });
});

app.post('/api/admin/configs/:id/rollback', { preHandler: configWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  const targetVersion = Number(body(request).version);
  if (!Number.isInteger(targetVersion)) throw fail(400, 'version 必须是整数');
  return configModule.rollback({ configId: id, targetVersion, adminId: request.admin!.sub, ip: request.ip });
});

app.delete('/api/admin/configs/:id', { preHandler: configWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  await configModule.remove({ configId: id, adminId: request.admin!.sub, ip: request.ip });
  return { deleted: true };
});

app.get('/api/admin/games/:id/configs/export', { preHandler: gameRead }, async request => {
  const gameId = routeParams(request).id!;
  return { exported_at: new Date().toISOString(), game_id: gameId, configs: (await query('SELECT config_key,environment,value,schema,description,version FROM game_configs WHERE game_id=$1 ORDER BY environment,config_key', [gameId])).rows };
});

app.post('/api/admin/games/:id/configs/import', { preHandler: gameWrite }, async request => {
  const gameId = routeParams(request).id!;
  const configs = body(request).configs;
  if (!Array.isArray(configs) || configs.length > 500) throw fail(400, 'configs 必须是数组且最多 500 项');
  const items = configs.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail(400, `configs[${index}] 必须是对象`);
    const config = item as JsonObject;
    return {
      configKey: requiredString(config.config_key, `configs[${index}].config_key`, 128),
      environment: asString(config.environment, 'production'),
      value: optionalJson(config.value),
      ...(config.schema !== undefined ? { schema: config.schema } : {}),
      description: asString(config.description),
    };
  });
  return configModule.importMany({ gameId, items, adminId: request.admin!.sub, ip: request.ip });
});

app.get('/api/admin/games/:id/users', { preHandler: gameRead }, async request => {
  const q = asString(searchParams(request).q);
  const limit = Math.min(Number(searchParams(request).limit) || 50, 200);
  return (await query(`SELECT u.*,(SELECT count(*)::int FROM user_archives a WHERE a.user_id=u.id) archive_count
    FROM game_users u WHERE game_id=$1 AND ($2='' OR openid ILIKE '%'||$2||'%' OR external_user_id ILIKE '%'||$2||'%')
    ORDER BY updated_at DESC LIMIT $3`, [routeParams(request).id, q, limit])).rows;
});

app.get('/api/admin/users/:id/archives', { preHandler: userReadAdmin }, async request =>
  (await query('SELECT * FROM user_archives WHERE user_id=$1 ORDER BY slot', [routeParams(request).id])).rows);

app.get('/api/admin/archives/:id/history', { preHandler: archiveReadAdmin }, async request =>
  (await query('SELECT id,slot,version,data,reason,created_at FROM archive_revisions WHERE archive_id=$1 ORDER BY version DESC', [routeParams(request).id])).rows);

app.put('/api/admin/archives/:id', { preHandler: archiveWriteAdmin }, async request => {
  const b = body(request);
  const version = Number(b.version);
  if (!Number.isInteger(version)) throw fail(400, 'version 必填');
  return archiveModule.update({
    archiveId: routeParams(request).id!,
    data: optionalJson(b.data),
    version,
    actor: { actorType: 'admin', actorId: request.admin!.sub, adminId: request.admin!.sub, ip: request.ip },
  });
});

app.post('/api/admin/archives/:id/restore', { preHandler: archiveWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  const targetVersion = Number(body(request).version);
  if (!Number.isInteger(targetVersion)) throw fail(400, 'version 必填');
  return archiveModule.restore({
    archiveId: id,
    targetVersion,
    actor: { actorType: 'admin', actorId: request.admin!.sub, adminId: request.admin!.sub, ip: request.ip },
  });
});

app.delete('/api/admin/archives/:id', { preHandler: archiveWriteAdmin }, async request => {
  const id = routeParams(request).id!;
  await archiveModule.remove({
    archiveId: id,
    actor: { actorType: 'admin', actorId: request.admin!.sub, adminId: request.admin!.sub, ip: request.ip },
  });
  return { deleted: true };
});

app.get('/api/admin/games/:id/audit-logs', { preHandler: gameRead }, async request => {
  const limit = Math.min(Number(searchParams(request).limit) || 100, 500);
  return (await query(`SELECT l.*,a.username admin_name FROM audit_logs l LEFT JOIN admins a ON a.id=l.admin_id WHERE l.game_id=$1 ORDER BY l.created_at DESC LIMIT $2`, [routeParams(request).id, limit])).rows;
});

app.get('/api/admin/games/:id/metrics', { preHandler: gameRead }, async request => {
  const days = Math.min(Math.max(Number(searchParams(request).days) || 7, 1), 90);
  const daily = (await query(`SELECT metric_date,sum(requests)::int requests,sum(errors)::int errors,
    CASE WHEN sum(requests)>0 THEN round(sum(total_duration_ms)::numeric/sum(requests),2) ELSE 0 END avg_duration_ms
    FROM api_metrics_daily WHERE game_id=$1 AND metric_date>=CURRENT_DATE-$2::integer GROUP BY metric_date ORDER BY metric_date`, [routeParams(request).id, days])).rows;
  return { days, daily };
});

app.get('/api/admin/games/:id/alerts', { preHandler: gameRead }, async request => {
  const gameId = routeParams(request).id!;
  const game = (await query('SELECT settings FROM games WHERE id=$1', [gameId])).rows[0];
  if (!game) throw fail(404, '游戏不存在');
  const settings = game.settings as JsonObject;
  const threshold = Number(settings.error_rate_threshold || 0.05);
  const today = (await query(`SELECT sum(requests)::int requests,sum(errors)::int errors FROM api_metrics_daily WHERE game_id=$1 AND metric_date=CURRENT_DATE`, [gameId])).rows[0] || { requests: 0, errors: 0 };
  const requests = Number(today.requests || 0), errors = Number(today.errors || 0), rate = requests ? errors / requests : 0;
  return { alerts: rate > threshold ? [{ level: 'warning', code: 'HIGH_ERROR_RATE', message: `今日 API 错误率 ${(rate * 100).toFixed(2)}% 超过阈值 ${(threshold * 100).toFixed(2)}%` }] : [], summary: { requests, errors, error_rate: rate, threshold } };
});

app.get('/api/admin/games/:id/event-definitions', { preHandler: gameRead }, async request =>
  analyticsModule.listDefinitions(routeParams(request).id!));

app.post('/api/admin/games/:id/event-definitions', { preHandler: gameWrite }, async request => {
  const b = body(request);
  const definition = await analyticsModule.defineEvent({
    gameId: routeParams(request).id!,
    eventKey: requiredString(b.event_key, 'event_key', 96),
    name: requiredString(b.name, 'name', 128),
    category: asString(b.category, 'custom'),
    description: asString(b.description),
  });
  await writeAudit({
    request,
    gameId: definition.game_id,
    action: 'analytics.event_definition.create',
    resourceType: 'event_definition',
    resourceId: definition.id,
    after: definition,
  });
  return definition;
});

app.patch('/api/admin/event-definitions/:id', { preHandler: eventDefinitionWrite }, async request => {
  const id = routeParams(request).id!;
  const b = body(request);
  const before = (await query('SELECT * FROM game_event_definitions WHERE id=$1', [id])).rows[0];
  const definition = await analyticsModule.updateDefinition({
    definitionId: id,
    ...(typeof b.name === 'string' ? { name: b.name } : {}),
    ...(typeof b.category === 'string' ? { category: b.category } : {}),
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
    ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
  });
  await writeAudit({
    request,
    gameId: definition.game_id,
    action: 'analytics.event_definition.update',
    resourceType: 'event_definition',
    resourceId: definition.id,
    before,
    after: definition,
  });
  return definition;
});

app.delete('/api/admin/event-definitions/:id', { preHandler: eventDefinitionWrite }, async request => {
  const definition = await analyticsModule.removeDefinition(routeParams(request).id!);
  await writeAudit({
    request,
    gameId: definition.game_id,
    action: 'analytics.event_definition.delete',
    resourceType: 'event_definition',
    resourceId: definition.id,
    before: definition,
  });
  return { deleted: true };
});

app.get('/api/admin/games/:id/analytics', { preHandler: gameRead }, async request => {
  const summary = await analyticsModule.getSummary({
    gameId: routeParams(request).id!,
    days: Number(searchParams(request).days) || 7,
  });
  return {
    days: summary.days,
    total_events: summary.totalEvents,
    today_events: summary.todayEvents,
    unique_actors: summary.uniqueActors,
    by_event: summary.byEvent.map(item => ({
      event_key: item.eventKey,
      name: item.name,
      category: item.category,
      enabled: item.enabled,
      count: item.count,
      unique_actors: item.uniqueActors,
    })),
    daily: summary.daily,
  };
});

app.get('/api/client/configs', { preHandler: [configRead, clientReadLimit] }, async (request, reply) => {
  const environment = searchParams(request).environment || 'production';
  const game = currentGame(request);
  const rows = (await query('SELECT config_key,value,version,updated_at FROM game_configs WHERE game_id=$1 AND environment=$2 ORDER BY config_key', [game.id, environment])).rows;
  const etag = `"${sha256(JSON.stringify(rows))}"`;
  reply.header('ETag', etag).header('Cache-Control', 'private, max-age=60');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return { game_id: game.game_key, environment, configs: Object.fromEntries(rows.map(row => [row.config_key, { value: row.value, version: row.version, updated_at: row.updated_at }])) };
});

app.get('/api/client/configs/:key', { preHandler: [configRead, clientReadLimit] }, async (request, reply) => {
  const result = await query('SELECT config_key,value,version,updated_at FROM game_configs WHERE game_id=$1 AND environment=$2 AND config_key=$3', [currentGame(request).id, searchParams(request).environment || 'production', routeParams(request).key]);
  const row = result.rows[0];
  if (!row) throw fail(404, '配置不存在');
  const etag = `"${sha256(JSON.stringify(row))}"`;
  reply.header('ETag', etag).header('Cache-Control', 'private, max-age=60');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return row;
});

app.post('/api/client/users/resolve', { schema: resolveSchema, preHandler: [userResolve, clientWriteLimit] }, async request => {
  const b = body(request);
  const game = currentGame(request);
  const session = await identityModule.resolveTrusted({
    gameId: game.id,
    gameKey: game.game_key,
    ...(typeof b.openid === 'string' ? { openid: b.openid } : {}),
    ...(typeof b.user_id === 'string' ? { externalUserId: b.user_id } : {}),
    ...(b.profile && typeof b.profile === 'object' && !Array.isArray(b.profile) ? { profile: b.profile as Record<string, unknown> } : {}),
  });
  return { ...session.user, user_token: session.userToken, expires_in: session.expiresIn };
});

app.post('/api/client/session', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['provider', 'credential'],
      properties: {
        provider: { type: 'string', minLength: 1, maxLength: 64 },
        credential: { type: 'string', minLength: 1, maxLength: 8192 },
      },
    },
  },
  preHandler: sessionLimit,
}, async request => {
  const gameKey = request.headers['x-game-id'];
  if (typeof gameKey !== 'string') throw fail(401, '缺少 X-Game-Id');
  const b = body(request);
  const session = await identityModule.startSession({
    gameKey,
    provider: requiredString(b.provider, 'provider', 64),
    credential: requiredString(b.credential, 'credential', 8192),
  });
  return { ...session.user, user_token: session.userToken, expires_in: session.expiresIn };
});

// 可信服务端可携带 analytics:write Key 代玩家上报，公开游戏客户端应使用 /me/events。
app.post('/api/client/events', { schema: eventsSchema, preHandler: [analyticsWrite, clientWriteLimit] }, async request =>
  analyticsModule.recordEvents({ gameId: currentGame(request).id, events: analyticsEvents(body(request).events) }));

app.post('/api/client/me/events', { schema: eventsSchema, preHandler: [requireUser, clientWriteLimit] }, async request =>
  analyticsModule.recordEvents({
    gameId: request.userAccess!.game_id,
    events: analyticsEvents(body(request).events, request.userAccess!.sub),
  }));

async function saveUserArchive(request: FastifyRequest, gameId: string, userId: string, slot: string): Promise<ArchiveRow> {
  const b = body(request);
  const idempotencyKey = request.headers['idempotency-key'];
  if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') throw fail(400, 'Idempotency-Key 必须是字符串');
  const result = await archiveModule.save({
    gameId,
    userId,
    slot,
    data: b.data,
    ...(Number.isInteger(b.version) ? { version: Number(b.version) } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    actor: request.userAccess
      ? { actorType: 'user', actorId: request.userAccess.sub, ip: request.ip }
      : { actorType: 'game', ip: request.ip, ...(request.game?.key_id ? { actorId: request.game.key_id } : {}) },
  });
  return result.archive;
}

app.get('/api/client/me/archives/:slot', { preHandler: [requireUser, clientReadLimit] }, async request => {
  const user = request.userAccess!;
  const result = await query('SELECT id,slot,data,version,updated_at FROM user_archives WHERE game_id=$1 AND user_id=$2 AND slot=$3', [user.game_id, user.sub, routeParams(request).slot]);
  if (!result.rowCount) throw fail(404, '存档不存在');
  return result.rows[0];
});

app.put('/api/client/me/archives/:slot', { schema: archiveSchema, preHandler: [requireUser, clientWriteLimit] }, async request =>
  saveUserArchive(request, request.userAccess!.game_id, request.userAccess!.sub, routeParams(request).slot!));

app.delete('/api/client/me/archives/:slot', { preHandler: [requireUser, clientWriteLimit] }, async request => {
  const user = request.userAccess!;
  const archive = (await query<{ id: string }>('SELECT id FROM user_archives WHERE game_id=$1 AND user_id=$2 AND slot=$3', [user.game_id, user.sub, routeParams(request).slot])).rows[0];
  if (!archive) throw fail(404, '存档不存在');
  await archiveModule.remove({ archiveId: archive.id, actor: { actorType: 'user', actorId: user.sub, ip: request.ip } });
  return { deleted: true };
});

// 兼容可信服务端调用。必须使用带 archive:* 权限的 Key；公开客户端应使用 /me 路径。
app.get('/api/client/users/:userId/archives/:slot', { preHandler: [archiveRead, clientReadLimit] }, async request => {
  const p = routeParams(request);
  const result = await query('SELECT id,slot,data,version,updated_at FROM user_archives WHERE game_id=$1 AND user_id=$2 AND slot=$3', [currentGame(request).id, p.userId, p.slot]);
  if (!result.rowCount) throw fail(404, '存档不存在');
  return result.rows[0];
});

app.put('/api/client/users/:userId/archives/:slot', { schema: archiveSchema, preHandler: [archiveWrite, clientWriteLimit] }, async request => {
  const p = routeParams(request);
  return saveUserArchive(request, currentGame(request).id, p.userId!, p.slot!);
});

const adminHtmlPath = path.resolve('public/index.html');
let productionAdminHtml: string | null = null;
const sendAdminHtml = async (reply: FastifyReply) => reply.type('text/html; charset=utf-8').send(productionAdminHtml ?? await fs.readFile(adminHtmlPath, 'utf8'));
app.get('/', async (_request, reply) => sendAdminHtml(reply));
app.get('/admin', async (_request, reply) => sendAdminHtml(reply));

async function bootstrap(): Promise<void> {
  if (JWT_SECRET.includes('development-only') && env.NODE_ENV === 'production') throw new Error('生产环境必须设置 JWT_SECRET');
  if (env.NODE_ENV === 'production') productionAdminHtml = await fs.readFile(adminHtmlPath, 'utf8');
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    if (env.ADMIN_PASSWORD.length < 10) throw new Error('ADMIN_PASSWORD 必须至少 10 位');
    await query(`INSERT INTO admins(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,updated_at=now()`, [env.ADMIN_USERNAME, hashPassword(env.ADMIN_PASSWORD)]);
  }
  app.log.info({ databaseMode }, databaseMode === 'pglite' ? '使用本地嵌入式数据库' : '使用外部 PostgreSQL');
  retentionScheduler = startRetentionScheduler({
    query,
    auditDays: Number(env.AUDIT_RETENTION_DAYS || 0),
    onError: error => app.log.warn(error, 'retention task failed'),
  });
  await app.listen({ port: PORT, host: HOST });
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, '正在安全关闭服务');
  try {
    retentionScheduler?.close();
    await app.close();
    await pool.end();
    app.log.info('服务和数据库已安全关闭');
    process.exit(0);
  } catch (error) {
    app.log.error(error, '安全关闭失败');
    process.exit(1);
  }
}

return { app, bootstrap, shutdown };
}

export const { app, bootstrap, shutdown } = createApp();
