import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityModule, type PlatformCredentialVerifier } from '../src/modules/identity.js';
import { createTestDatabase } from './support/database.js';

test('平台凭证验证成功后签发用户会话并稳定解析同一身份', async () => {
  const database = await createTestDatabase();
  try {
    await database.query(`INSERT INTO games(game_key,name,api_key_hash) VALUES('login_game','Login',repeat('f',64))`);
    await database.query(`INSERT INTO games(game_key,name,api_key_hash) VALUES('second_login_game','Second Login',repeat('e',64))`);
    const verifier: PlatformCredentialVerifier = {
      async verify(input) {
        assert.equal(input.provider, 'wechat');
        assert.match(input.credential, /^valid-code-/);
        return { subject: 'openid-100', profile: { nickname: '玩家' } };
      },
    };
    const identities = createIdentityModule(database, {
      verifier,
      signUserToken: payload => `token:${payload.sub}`,
    });

    const first = await identities.startSession({ gameKey: 'login_game', provider: 'wechat', credential: 'valid-code-1' });
    const second = await identities.startSession({ gameKey: 'login_game', provider: 'wechat', credential: 'valid-code-2' });
    const otherGame = await identities.startSession({ gameKey: 'second_login_game', provider: 'wechat', credential: 'valid-code-3' });

    assert.equal(second.user.id, first.user.id);
    assert.notEqual(otherGame.user.id, first.user.id);
    assert.equal(first.user.openid, 'openid-100');
    assert.equal(first.userToken, `token:${first.user.id}`);

    await database.query(`UPDATE games SET enabled=false WHERE game_key='second_login_game'`);
    await assert.rejects(
      identities.startSession({ gameKey: 'second_login_game', provider: 'wechat', credential: 'valid-code-4' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 403);
        return true;
      },
    );
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
