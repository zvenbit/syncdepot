import crypto from 'node:crypto';
import type { DatabaseClient } from '../db.js';
import { createWechatCredentialVerifier } from '../adapters/wechat-credential-verifier.js';
import type { PlatformCredentialVerifier } from './identity.js';

type Queryable = { query: DatabaseClient['query'] };

export type SecretCipher = {
  encrypt(plaintext: string, context: string): string;
  decrypt(encoded: string, context: string): string;
};

export type WechatCredentialStatus = {
  provider: 'wechat';
  configured: boolean;
  app_id: string | null;
  updated_at: string | null;
};

type CredentialRow = {
  game_id: string;
  app_id: string;
  secret_ciphertext: string;
  updated_at: string;
};

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const credentialContext = (gameId: string) => `${gameId}:wechat`;

export function createSecretCipher(masterKey: string): SecretCipher {
  if (Buffer.byteLength(masterKey, 'utf8') < 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY 必须至少 32 位');
  }
  const key = crypto.createHash('sha256').update(masterKey, 'utf8').digest();

  return {
    encrypt(plaintext, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return ['v1', iv.toString('base64url'), authTag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },

    decrypt(encoded, context) {
      try {
        const [version, ivValue, authTagValue, ciphertextValue, extra] = encoded.split('.');
        if (version !== 'v1' || !ivValue || !authTagValue || ciphertextValue === undefined || extra !== undefined) {
          throw new Error('invalid credential payload');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextValue, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error('项目凭证解密失败');
      }
    },
  };
}

export function createGameCredentialModule(database: Queryable, options: {
  cipher?: SecretCipher;
  fallbackVerifier: PlatformCredentialVerifier;
  fetch?: typeof globalThis.fetch;
}) {
  async function status(gameId: string, client: Queryable = database): Promise<WechatCredentialStatus> {
    const game = (await client.query<{ app_id: string | null; updated_at: string | null }>(
      `SELECT c.app_id,c.updated_at
       FROM games g LEFT JOIN game_platform_credentials c
         ON c.game_id=g.id AND c.provider='wechat'
       WHERE g.id=$1`,
      [gameId],
    )).rows[0];
    if (!game) throw fail(404, '游戏不存在');
    return {
      provider: 'wechat',
      configured: Boolean(game.app_id),
      app_id: game.app_id,
      updated_at: game.updated_at,
    };
  }

  async function saveWechat(command: {
    gameId: string;
    appId: string;
    appSecret?: string;
  }, client: Queryable = database): Promise<WechatCredentialStatus> {
    if (!options.cipher) throw fail(503, '尚未配置项目凭证加密密钥');
    const gameExists = (await client.query('SELECT id FROM games WHERE id=$1', [command.gameId])).rowCount;
    if (!gameExists) throw fail(404, '游戏不存在');

    if (!command.appSecret) {
      const current = (await client.query<{ app_id: string; secret_ciphertext: string }>(
        `SELECT app_id,secret_ciphertext FROM game_platform_credentials
         WHERE game_id=$1 AND provider='wechat'`,
        [command.gameId],
      )).rows[0];
      if (!current) throw fail(400, '首次配置微信登录时必须填写 AppSecret');
      if (current.app_id !== command.appId) throw fail(400, '修改 AppID 时必须重新填写 AppSecret');
      try {
        options.cipher.decrypt(current.secret_ciphertext, credentialContext(command.gameId));
      } catch {
        throw fail(503, '微信登录配置不可用，请重新填写 AppSecret');
      }
      return status(command.gameId, client);
    }

    const secretCiphertext = options.cipher.encrypt(command.appSecret, credentialContext(command.gameId));
    await client.query(
      `INSERT INTO game_platform_credentials(game_id,provider,app_id,secret_ciphertext)
       VALUES($1,'wechat',$2,$3)
       ON CONFLICT(game_id,provider) DO UPDATE SET
         app_id=excluded.app_id,secret_ciphertext=excluded.secret_ciphertext,updated_at=now()`,
      [command.gameId, command.appId, secretCiphertext],
    );
    return status(command.gameId, client);
  }

  async function removeWechat(gameId: string, client: Queryable = database): Promise<WechatCredentialStatus> {
    const gameExists = (await client.query('SELECT id FROM games WHERE id=$1', [gameId])).rowCount;
    if (!gameExists) throw fail(404, '游戏不存在');
    await client.query(
      `DELETE FROM game_platform_credentials WHERE game_id=$1 AND provider='wechat'`,
      [gameId],
    );
    return status(gameId, client);
  }

  const verifier: PlatformCredentialVerifier = {
    async verify(input) {
      if (input.provider !== 'wechat') return options.fallbackVerifier.verify(input);
      const row = (await database.query<CredentialRow>(
        `SELECT g.id game_id,c.app_id,c.secret_ciphertext,c.updated_at
         FROM games g JOIN game_platform_credentials c
           ON c.game_id=g.id AND c.provider='wechat'
         WHERE g.game_key=$1`,
        [input.gameKey],
      )).rows[0];
      if (!row) return options.fallbackVerifier.verify(input);
      if (!options.cipher) throw fail(503, '微信登录配置不可用');

      let appSecret: string;
      try {
        appSecret = options.cipher.decrypt(row.secret_ciphertext, credentialContext(row.game_id));
      } catch {
        throw fail(503, '微信登录配置不可用');
      }
      const wechat = createWechatCredentialVerifier({
        appId: row.app_id,
        appSecret,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return wechat.verify(input);
    },
  };

  return { status, saveWechat, removeWechat, verifier };
}
