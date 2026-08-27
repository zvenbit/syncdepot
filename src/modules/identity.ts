import type { DatabaseClient } from '../db.js';

export type VerifiedIdentity = {
  subject: string;
  externalUserId?: string;
  profile?: Record<string, unknown>;
};

export type PlatformCredentialVerifier = {
  verify(input: { gameKey: string; provider: string; credential: string }): Promise<VerifiedIdentity>;
};

export type IdentityDatabase = {
  query: DatabaseClient['query'];
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
};

type GameRow = { id: string; game_key: string; enabled: boolean };
type UserRow = {
  id: string;
  game_id: string;
  openid: string | null;
  external_user_id: string | null;
  profile: Record<string, unknown>;
};

type UserTokenPayload = { sub: string; game_id: string; game_key: string; kind: 'user' };

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export function createIdentityModule(database: IdentityDatabase, options: {
  verifier: PlatformCredentialVerifier;
  signUserToken(payload: UserTokenPayload): string;
}) {
  return {
    async resolveTrusted(command: {
      gameId: string;
      gameKey: string;
      openid?: string;
      externalUserId?: string;
      profile?: Record<string, unknown>;
    }) {
      if (!command.openid && !command.externalUserId) throw fail(400, 'openid 和 externalUserId 至少提供一个');
      const user = await database.transaction(async client => {
        const matches = (await client.query<UserRow>(
          `SELECT * FROM game_users WHERE game_id=$1
           AND (($2::text IS NOT NULL AND openid=$2) OR ($3::text IS NOT NULL AND external_user_id=$3)) FOR UPDATE`,
          [command.gameId, command.openid || null, command.externalUserId || null],
        )).rows;
        const ids = new Set(matches.map(item => item.id));
        if (ids.size > 1) throw fail(409, 'openid 与 user_id 身份标识分别属于不同用户，不能自动合并');
        let resolved = matches[0];
        if (resolved) {
          resolved = (await client.query<UserRow>(
            `UPDATE game_users SET openid=COALESCE($2,openid),external_user_id=COALESCE($3,external_user_id),
             profile=COALESCE($4,profile),updated_at=now() WHERE id=$1 RETURNING *`,
            [resolved.id, command.openid || null, command.externalUserId || null, command.profile || null],
          )).rows[0]!;
        } else {
          const conflictKey = command.openid ? 'openid' : 'external_user_id';
          resolved = (await client.query<UserRow>(
            `INSERT INTO game_users(game_id,openid,external_user_id,profile) VALUES($1,$2,$3,$4)
             ON CONFLICT(game_id,${conflictKey}) DO UPDATE SET
             openid=COALESCE(excluded.openid,game_users.openid),
             external_user_id=COALESCE(excluded.external_user_id,game_users.external_user_id),
             profile=excluded.profile,updated_at=now() RETURNING *`,
            [command.gameId, command.openid || null, command.externalUserId || null, command.profile || {}],
          )).rows[0]!;
        }
        if (command.openid) {
          await client.query(
            `INSERT INTO user_identities(game_id,user_id,provider,subject) VALUES($1,$2,'wechat',$3)
             ON CONFLICT(game_id,provider,subject) DO UPDATE SET user_id=excluded.user_id,updated_at=now()`,
            [command.gameId, resolved.id, command.openid],
          );
        }
        if (command.externalUserId) {
          await client.query(
            `INSERT INTO user_identities(game_id,user_id,provider,subject) VALUES($1,$2,'external',$3)
             ON CONFLICT(game_id,provider,subject) DO UPDATE SET user_id=excluded.user_id,updated_at=now()`,
            [command.gameId, resolved.id, command.externalUserId],
          );
        }
        return resolved;
      });
      const userToken = options.signUserToken({ sub: user.id, game_id: command.gameId, game_key: command.gameKey, kind: 'user' });
      return { user, userToken, expiresIn: 7200 };
    },

    async startSession(command: { gameKey: string; provider: string; credential: string }) {
      if (!command.provider || command.provider.length > 64 || !command.credential) throw fail(400, 'provider 和 credential 必填');
      const game = (await database.query<GameRow>(
        'SELECT id,game_key,enabled FROM games WHERE game_key=$1', [command.gameKey],
      )).rows[0];
      if (!game || !game.enabled) throw fail(403, '游戏不存在或已停用');

      const verified = await options.verifier.verify(command);
      if (!verified.subject || verified.subject.length > 191) throw fail(401, '平台凭证未返回有效用户身份');
      const user = await database.transaction(async client => {
        const existing = (await client.query<UserRow>(
          `SELECT u.* FROM user_identities i JOIN game_users u ON u.id=i.user_id
           WHERE i.game_id=$1 AND i.provider=$2 AND i.subject=$3 FOR UPDATE`,
          [game.id, command.provider, verified.subject],
        )).rows[0];
        if (existing) {
          if (verified.profile) {
            return (await client.query<UserRow>(
              'UPDATE game_users SET profile=$2,updated_at=now() WHERE id=$1 RETURNING *',
              [existing.id, verified.profile],
            )).rows[0]!;
          }
          return existing;
        }

        const openid = command.provider === 'wechat' ? verified.subject : null;
        const externalId = verified.externalUserId || (openid ? null : `${command.provider}:${verified.subject}`);
        let resolved = (await client.query<UserRow>(
          `SELECT * FROM game_users WHERE game_id=$1
           AND (($2::text IS NOT NULL AND openid=$2) OR ($3::text IS NOT NULL AND external_user_id=$3)) FOR UPDATE`,
          [game.id, openid, externalId],
        )).rows[0];
        if (!resolved) {
          const conflictKey = openid ? 'openid' : 'external_user_id';
          resolved = (await client.query<UserRow>(
            `INSERT INTO game_users(game_id,openid,external_user_id,profile) VALUES($1,$2,$3,$4)
             ON CONFLICT(game_id,${conflictKey}) DO UPDATE SET profile=excluded.profile,updated_at=now() RETURNING *`,
            [game.id, openid, externalId, verified.profile || {}],
          )).rows[0]!;
        }
        const linked = await client.query<{ user_id: string }>(
          `INSERT INTO user_identities(game_id,user_id,provider,subject) VALUES($1,$2,$3,$4)
           ON CONFLICT(game_id,provider,subject) DO NOTHING RETURNING user_id`,
          [game.id, resolved.id, command.provider, verified.subject],
        );
        if (!linked.rowCount) {
          const winner = (await client.query<UserRow>(
            `SELECT u.* FROM user_identities i JOIN game_users u ON u.id=i.user_id
             WHERE i.game_id=$1 AND i.provider=$2 AND i.subject=$3`,
            [game.id, command.provider, verified.subject],
          )).rows[0];
          if (winner) resolved = winner;
        }
        return resolved;
      });
      const userToken = options.signUserToken({ sub: user.id, game_id: game.id, game_key: game.game_key, kind: 'user' });
      return { user, userToken, expiresIn: 7200 };
    },
  };
}

export function createWebhookCredentialVerifier(options: {
  url: string;
  secret?: string;
  fetch?: typeof globalThis.fetch;
}): PlatformCredentialVerifier {
  const request = options.fetch || globalThis.fetch;
  return {
    async verify(input): Promise<VerifiedIdentity> {
      let response: Response;
      try {
        response = await request(options.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.secret ? { Authorization: `Bearer ${options.secret}` } : {}),
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        throw fail(503, '平台身份验证暂时不可用');
      }
      const data = await response.json().catch(() => ({})) as Partial<VerifiedIdentity> & { error?: string };
      if (!response.ok || typeof data.subject !== 'string') throw fail(401, data.error || '平台凭证无效');
      return {
        subject: data.subject,
        ...(typeof data.externalUserId === 'string' ? { externalUserId: data.externalUserId } : {}),
        ...(data.profile && typeof data.profile === 'object' ? { profile: data.profile } : {}),
      };
    },
  };
}
