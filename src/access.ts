import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from './db.js';
import { sha256, verifyToken, type TokenPayload } from './lib.js';
import { createDatabaseRateLimitStore, createMemoryRateLimitStore, type RateLimitStore } from './rate-limit.js';

export const GAME_SCOPES = ['config:read', 'user:resolve', 'archive:read', 'archive:write', 'analytics:write'] as const;
export type GameScope = typeof GAME_SCOPES[number];
export type GameAccess = { id: string; game_key: string; name: string; key_id: string; scopes: string[] };
export type UserAccess = TokenPayload & { sub: string; game_id: string; kind: 'user' };

export function bearer(request: FastifyRequest): string | undefined {
  return request.headers.authorization?.replace(/^Bearer\s+/i, '');
}

export function createGameGuard(scope: GameScope, databaseQuery: typeof query = query) {
  return async function requireGameScope(request: FastifyRequest): Promise<void> {
    const gameKey = request.headers['x-game-id'];
    const apiKey = request.headers['x-api-key'];
    if (typeof gameKey !== 'string' || typeof apiKey !== 'string') {
      throw Object.assign(new Error('缺少 X-Game-Id 或 X-Api-Key'), { statusCode: 401 });
    }
    const result = await databaseQuery<GameAccess>(`SELECT g.id,g.game_key,g.name,k.id key_id,k.scopes
      FROM games g JOIN game_api_keys k ON k.game_id=g.id
      WHERE g.game_key=$1 AND k.key_hash=$2 AND g.enabled=true AND k.enabled=true
        AND (k.expires_at IS NULL OR k.expires_at>now())`, [gameKey, sha256(apiKey)]);
    const access = result.rows[0];
    if (!access || !access.scopes.includes(scope)) {
      throw Object.assign(new Error('游戏凭证无效或缺少权限'), { statusCode: 403 });
    }
    request.game = access;
    void databaseQuery('UPDATE game_api_keys SET last_used_at=now(),last_ip=$2 WHERE id=$1', [access.key_id, request.ip]).catch(() => undefined);
  };
}

export function createUserGuard(jwtSecret: string, databaseQuery: typeof query = query) {
  return async function requireUser(request: FastifyRequest): Promise<void> {
    const payload = verifyToken(bearer(request), jwtSecret) as UserAccess | null;
    if (!payload || payload.kind !== 'user' || !payload.game_id) {
      throw Object.assign(new Error('用户登录已失效'), { statusCode: 401 });
    }
    const active = await databaseQuery(
      `SELECT 1 FROM game_users u JOIN games g ON g.id=u.game_id
       WHERE u.id=$1 AND u.game_id=$2 AND g.enabled=true`,
      [payload.sub, payload.game_id],
    );
    if (!active.rowCount) throw Object.assign(new Error('用户或游戏已停用'), { statusCode: 401 });
    request.userAccess = payload;
  };
}

const defaultRateLimitStore = process.env.RATE_LIMIT_STORE === 'database'
  ? createDatabaseRateLimitStore(query)
  : createMemoryRateLimitStore();

export function rateLimit(options: { limit: number; windowMs: number; key?: (request: FastifyRequest) => string }, store: RateLimitStore = defaultRateLimitStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    const key = options.key?.(request) || request.ip;
    const bucketKey = `${request.routeOptions.url}:${key}`;
    const result = await store.consume(bucketKey, options.limit, options.windowMs, now);
    reply.header('X-RateLimit-Limit', options.limit).header('X-RateLimit-Remaining', result.remaining);
    if (!result.allowed) {
      reply.header('Retry-After', Math.ceil((result.resetAt - now) / 1000));
      throw Object.assign(new Error('请求过于频繁，请稍后重试'), { statusCode: 429 });
    }
  };
}
