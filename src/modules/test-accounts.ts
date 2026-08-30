import crypto from 'node:crypto';
import type { DatabaseClient } from '../db.js';
import { appendAudit, type AuditActor } from '../audit-log.js';
import { hashPassword, verifyPassword } from '../lib.js';

export type TestAccountDatabase = {
  query: DatabaseClient['query'];
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
};

export type TestAccount = {
  id: string;
  game_id: string;
  user_id: string;
  username: string;
  enabled: boolean;
  token_version: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  archive_count?: number;
  event_count?: number;
};

export type ClearedTestAccountData = {
  accountId: string;
  userId: string;
  archivesDeleted: number;
  eventsDeleted: number;
  idempotencyRecordsDeleted: number;
};

type TestAccountSecret = { account: TestAccount; password: string };
type AdminCommand = { adminId: string; ip?: string };
type UserTokenPayload = {
  sub: string;
  game_id: string;
  game_key: string;
  kind: 'user';
  test_account_id: string;
  test_account_version: number;
};

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const DUMMY_PASSWORD_HASH = hashPassword('invalid-test-account-password', '00000000000000000000000000000000');
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const generatedUsername = () => `test_${crypto.randomBytes(5).toString('hex')}`;
const generatedPassword = () => `test_${crypto.randomBytes(18).toString('base64url')}`;
const actor = (command: AdminCommand): AuditActor => ({
  adminId: command.adminId,
  actorType: 'admin',
  actorId: command.adminId,
  ...(command.ip ? { ip: command.ip } : {}),
});

function validateUsername(value: string): string {
  const username = value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw fail(400, '测试账号名必须是 3-64 位字母、数字、点、短横线或下划线');
  }
  return username;
}

function publicAccount(row: TestAccount): TestAccount {
  return {
    id: row.id,
    game_id: row.game_id,
    user_id: row.user_id,
    username: row.username,
    enabled: row.enabled,
    token_version: Number(row.token_version),
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.archive_count !== undefined ? { archive_count: Number(row.archive_count) } : {}),
    ...(row.event_count !== undefined ? { event_count: Number(row.event_count) } : {}),
  };
}

export function createTestAccountModule(database: TestAccountDatabase, options: {
  signUserToken(payload: UserTokenPayload): string;
  expiresIn?: number;
}) {
  return {
    async list(gameId: string): Promise<TestAccount[]> {
      const rows = (await database.query<TestAccount>(
        `SELECT a.id,a.game_id,a.user_id,a.username,a.enabled,a.token_version,
                a.last_login_at,a.created_at,a.updated_at,
                (SELECT count(*)::int FROM user_archives r WHERE r.user_id=a.user_id) archive_count,
                (SELECT count(*)::int FROM game_events e WHERE e.user_id=a.user_id) event_count
         FROM game_test_accounts a WHERE a.game_id=$1 ORDER BY a.created_at DESC`,
        [gameId],
      )).rows;
      return rows.map(publicAccount);
    },

    async create(command: AdminCommand & { gameId: string; username?: string }): Promise<TestAccountSecret> {
      const accountId = crypto.randomUUID();
      const username = validateUsername(command.username || generatedUsername());
      const password = generatedPassword();
      try {
        return await database.transaction(async client => {
          if (!(await client.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [command.gameId])).rowCount) {
            throw fail(404, '游戏不存在');
          }
          const user = (await client.query<{ id: string }>(
            `INSERT INTO game_users(game_id,external_user_id,profile)
             VALUES($1,$2,$3::jsonb) RETURNING id`,
            [
              command.gameId,
              `test-account:${accountId}`,
              JSON.stringify({ test_account: true, test_username: username }),
            ],
          )).rows[0]!;
          const account = (await client.query<TestAccount>(
            `INSERT INTO game_test_accounts(id,game_id,user_id,username,password_hash,created_by)
             VALUES($1,$2,$3,$4,$5,$6)
             RETURNING id,game_id,user_id,username,enabled,token_version,last_login_at,created_at,updated_at`,
            [accountId, command.gameId, user.id, username, hashPassword(password), command.adminId],
          )).rows[0]!;
          await appendAudit(client, {
            gameId: command.gameId,
            action: 'test_account.create',
            resourceType: 'game_test_account',
            resourceId: account.id,
            after: { username: account.username, user_id: account.user_id, enabled: true },
          }, actor(command));
          return { account: publicAccount(account), password };
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw fail(409, '该游戏已存在同名测试账号');
        throw error;
      }
    },

    async resetPassword(command: AdminCommand & { accountId: string }): Promise<TestAccountSecret> {
      const password = generatedPassword();
      return database.transaction(async client => {
        const before = (await client.query<TestAccount>(
          `SELECT id,game_id,user_id,username,enabled,token_version,last_login_at,created_at,updated_at
           FROM game_test_accounts WHERE id=$1 FOR UPDATE`,
          [command.accountId],
        )).rows[0];
        if (!before) throw fail(404, '测试账号不存在');
        const account = (await client.query<TestAccount>(
          `UPDATE game_test_accounts SET password_hash=$2,token_version=token_version+1,updated_at=now()
           WHERE id=$1
           RETURNING id,game_id,user_id,username,enabled,token_version,last_login_at,created_at,updated_at`,
          [command.accountId, hashPassword(password)],
        )).rows[0]!;
        await appendAudit(client, {
          gameId: account.game_id,
          action: 'test_account.password.reset',
          resourceType: 'game_test_account',
          resourceId: account.id,
          after: { username: account.username, token_version: account.token_version },
        }, actor(command));
        return { account: publicAccount(account), password };
      });
    },

    async setEnabled(command: AdminCommand & { accountId: string; enabled: boolean }): Promise<TestAccount> {
      return database.transaction(async client => {
        const before = (await client.query<TestAccount>(
          `SELECT id,game_id,user_id,username,enabled,token_version,last_login_at,created_at,updated_at
           FROM game_test_accounts WHERE id=$1 FOR UPDATE`,
          [command.accountId],
        )).rows[0];
        if (!before) throw fail(404, '测试账号不存在');
        const account = (await client.query<TestAccount>(
          `UPDATE game_test_accounts SET enabled=$2,token_version=token_version+1,updated_at=now()
           WHERE id=$1
           RETURNING id,game_id,user_id,username,enabled,token_version,last_login_at,created_at,updated_at`,
          [command.accountId, command.enabled],
        )).rows[0]!;
        await appendAudit(client, {
          gameId: account.game_id,
          action: command.enabled ? 'test_account.enable' : 'test_account.disable',
          resourceType: 'game_test_account',
          resourceId: account.id,
          before: { enabled: before.enabled },
          after: { enabled: account.enabled },
        }, actor(command));
        return publicAccount(account);
      });
    },

    async clearData(command: AdminCommand & { accountId: string }): Promise<ClearedTestAccountData> {
      return database.transaction(async client => {
        const account = (await client.query<TestAccount>(
          `SELECT id,game_id,user_id,username,enabled,token_version,last_login_at,created_at,updated_at
           FROM game_test_accounts WHERE id=$1 FOR UPDATE`,
          [command.accountId],
        )).rows[0];
        if (!account) throw fail(404, '测试账号不存在');
        const idempotencyRecords = await client.query(
          `DELETE FROM idempotency_records
           WHERE game_id=$1 AND response->>'user_id'=$2`,
          [account.game_id, account.user_id],
        );
        const archives = await client.query(
          'DELETE FROM user_archives WHERE game_id=$1 AND user_id=$2',
          [account.game_id, account.user_id],
        );
        const events = await client.query(
          'DELETE FROM game_events WHERE game_id=$1 AND user_id=$2',
          [account.game_id, account.user_id],
        );
        const result = {
          accountId: account.id,
          userId: account.user_id,
          archivesDeleted: archives.rowCount,
          eventsDeleted: events.rowCount,
          idempotencyRecordsDeleted: idempotencyRecords.rowCount,
        };
        await appendAudit(client, {
          gameId: account.game_id,
          action: 'test_account.data.clear',
          resourceType: 'game_test_account',
          resourceId: account.id,
          before: {
            archive_count: result.archivesDeleted,
            event_count: result.eventsDeleted,
            idempotency_record_count: result.idempotencyRecordsDeleted,
          },
          after: { archive_count: 0, event_count: 0, idempotency_record_count: 0 },
        }, actor(command));
        return result;
      });
    },

    async startSession(command: { gameKey: string; username: string; password: string }): Promise<{
      account: TestAccount;
      userToken: string;
      expiresIn: number;
    }> {
      const account = (await database.query<TestAccount & { password_hash: string; game_key: string }>(
        `SELECT a.*,g.game_key FROM game_test_accounts a
         JOIN games g ON g.id=a.game_id
         WHERE g.game_key=$1 AND lower(a.username)=lower($2) AND g.enabled=true AND a.enabled=true`,
        [command.gameKey, command.username.trim()],
      )).rows[0];
      const valid = verifyPassword(command.password, account?.password_hash || DUMMY_PASSWORD_HASH);
      if (!account || !valid) throw fail(401, '测试账号或密码错误');
      await database.query('UPDATE game_test_accounts SET last_login_at=now() WHERE id=$1', [account.id]);
      const userToken = options.signUserToken({
        sub: account.user_id,
        game_id: account.game_id,
        game_key: account.game_key,
        kind: 'user',
        test_account_id: account.id,
        test_account_version: Number(account.token_version),
      });
      return { account: publicAccount(account), userToken, expiresIn: options.expiresIn || 7200 };
    },
  };
}
