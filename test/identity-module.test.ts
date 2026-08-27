import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityModule, type PlatformCredentialVerifier } from '../src/modules/identity.js';
import { createTestDatabase } from './support/database.js';

test('平台凭证验证成功后签发用户会话并稳定解析同一身份', async () => {
  const database = await createTestDatabase();
  try {
    await database.query(`INSERT INTO games(game_key,name,api_key_hash) VALUES('login_game','Login',repeat('f',64))`);
    const verifier: PlatformCredentialVerifier = {
      async verify(input) {
        assert.equal(input.provider, 'wechat');
        assert.equal(input.credential, 'valid-code');
        return { subject: 'openid-100', profile: { nickname: '玩家' } };
      },
    };
    const identities = createIdentityModule(database, {
      verifier,
      signUserToken: payload => `token:${payload.sub}`,
    });

    const first = await identities.startSession({ gameKey: 'login_game', provider: 'wechat', credential: 'valid-code' });
    const second = await identities.startSession({ gameKey: 'login_game', provider: 'wechat', credential: 'valid-code' });

    assert.equal(second.user.id, first.user.id);
    assert.equal(first.user.openid, 'openid-100');
    assert.equal(first.userToken, `token:${first.user.id}`);
  } finally {
    await database.close();
  }
});

test('可信服务不会把属于不同用户的两个身份静默合并', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string; game_key: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('identity_conflict','Identity',repeat('8',64)) RETURNING id,game_key`)).rows[0]!;
    await database.query(`INSERT INTO game_users(game_id,openid) VALUES($1,'wx-a')`, [game.id]);
    await database.query(`INSERT INTO game_users(game_id,external_user_id) VALUES($1,'account-b')`, [game.id]);
    const identities = createIdentityModule(database, {
      verifier: { async verify() { return { subject: 'unused' }; } },
      signUserToken: payload => `token:${payload.sub}`,
    });

    await assert.rejects(
      identities.resolveTrusted({ gameId: game.id, gameKey: game.game_key, openid: 'wx-a', externalUserId: 'account-b' }),
      /身份标识分别属于不同用户/,
    );
  } finally {
    await database.close();
  }
});
