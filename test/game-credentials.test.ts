import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameCredentialModule,
  createSecretCipher,
} from '../src/modules/game-credentials.js';
import { createTestDatabase } from './support/database.js';

test('项目凭证使用随机密文并绑定所属游戏', () => {
  const cipher = createSecretCipher('credential-encryption-key-for-tests-0001');
  const first = cipher.encrypt('wechat-secret-a', 'game-a:wechat');
  const second = cipher.encrypt('wechat-secret-a', 'game-a:wechat');

  assert.notEqual(first, second);
  assert.doesNotMatch(first, /wechat-secret-a/);
  assert.equal(cipher.decrypt(first, 'game-a:wechat'), 'wechat-secret-a');
  assert.throws(() => cipher.decrypt(first, 'game-b:wechat'), /项目凭证解密失败/);
  assert.throws(
    () => createSecretCipher('another-credential-encryption-key-002').decrypt(first, 'game-a:wechat'),
    /项目凭证解密失败/,
  );
});

test('每个游戏使用自己的微信 AppID 和 AppSecret', async () => {
  const database = await createTestDatabase();
  try {
    const gameA = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('wechat_game_a','A',repeat('a',64)) RETURNING id`,
    )).rows[0]!;
    const gameB = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('wechat_game_b','B',repeat('b',64)) RETURNING id`,
    )).rows[0]!;
    const requests: URL[] = [];
    let fallbackCalls = 0;
    const credentials = createGameCredentialModule(database, {
      cipher: createSecretCipher('credential-encryption-key-for-tests-0001'),
      fetch: async input => {
        const url = new URL(String(input));
        requests.push(url);
        return Response.json({ openid: `openid-${url.searchParams.get('appid')}` });
      },
      fallbackVerifier: {
        async verify() {
          fallbackCalls += 1;
          return { subject: 'fallback-user' };
        },
      },
    });

    const statusA = await credentials.saveWechat({
      gameId: gameA.id,
      appId: 'wx-app-a',
      appSecret: 'wechat-secret-a',
    });
    await credentials.saveWechat({
      gameId: gameB.id,
      appId: 'wx-app-b',
      appSecret: 'wechat-secret-b',
    });

    assert.equal(statusA.configured, true);
    assert.equal(statusA.app_id, 'wx-app-a');
    assert.doesNotMatch(JSON.stringify(statusA), /wechat-secret-a|ciphertext/);

    const stored = await database.query<{ game_id: string; secret_ciphertext: string }>(
      `SELECT game_id,secret_ciphertext FROM game_platform_credentials ORDER BY game_id`,
    );
    assert.equal(stored.rows.length, 2);
    assert.doesNotMatch(JSON.stringify(stored.rows), /wechat-secret-a|wechat-secret-b/);

    const identityA = await credentials.verifier.verify({
      gameKey: 'wechat_game_a', provider: 'wechat', credential: 'code-a',
    });
    const identityB = await credentials.verifier.verify({
      gameKey: 'wechat_game_b', provider: 'wechat', credential: 'code-b',
    });
    assert.equal(identityA.subject, 'openid-wx-app-a');
    assert.equal(identityB.subject, 'openid-wx-app-b');
    assert.equal(requests[0]?.searchParams.get('secret'), 'wechat-secret-a');
    assert.equal(requests[1]?.searchParams.get('secret'), 'wechat-secret-b');
    assert.equal(requests[0]?.searchParams.get('js_code'), 'code-a');
    assert.equal(requests[1]?.searchParams.get('js_code'), 'code-b');

    await credentials.saveWechat({ gameId: gameA.id, appId: 'wx-app-a' });
    await assert.rejects(
      credentials.saveWechat({ gameId: gameA.id, appId: 'wx-app-a-changed' }),
      /修改 AppID 时必须重新填写 AppSecret/,
    );

    await credentials.removeWechat(gameA.id);
    const fallback = await credentials.verifier.verify({
      gameKey: 'wechat_game_a', provider: 'wechat', credential: 'code-after-remove',
    });
    assert.equal(fallback.subject, 'fallback-user');
    assert.equal(fallbackCalls, 1);
  } finally {
    await database.close();
  }
});

test('未配置服务级加密密钥时拒绝保存或读取项目 AppSecret', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('encrypted_game','Encrypted',repeat('c',64)) RETURNING id`,
    )).rows[0]!;
    const cipher = createSecretCipher('credential-encryption-key-for-tests-0001');
    const configured = createGameCredentialModule(database, {
      cipher,
      fallbackVerifier: { async verify() { return { subject: 'unused' }; } },
    });
    await configured.saveWechat({ gameId: game.id, appId: 'wx-encrypted', appSecret: 'secret-encrypted' });

    const withoutCipher = createGameCredentialModule(database, {
      fallbackVerifier: { async verify() { return { subject: 'unused' }; } },
    });
    await assert.rejects(
      withoutCipher.saveWechat({ gameId: game.id, appId: 'wx-encrypted', appSecret: 'new-secret' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, '尚未配置项目凭证加密密钥');
        return true;
      },
    );
    await assert.rejects(
      withoutCipher.verifier.verify({ gameKey: 'encrypted_game', provider: 'wechat', credential: 'code' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, '微信登录配置不可用');
        return true;
      },
    );
  } finally {
    await database.close();
  }
});
