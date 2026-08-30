import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/lib.js';

test('玩家 Token 无需服务端 API Key 即可读取所属游戏的全部配置', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncdepot-player-config-'));
  process.env.PGLITE_DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  const { query, transaction, pool } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const { app } = createApp({
    query,
    transaction,
    pool,
    databaseMode: 'pglite',
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'player-config-test-secret-that-is-long-enough',
    },
    identityVerifier: {
      async verify() { return { subject: 'openid-player-config' }; },
    },
  });

  try {
    for (const name of (await fs.readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await query(await fs.readFile(path.resolve('migrations', name), 'utf8'));
    }
    const game = (await query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('player_config_game','Player Config',repeat('a',64)) RETURNING id`,
    )).rows[0]!;
    await query(
      `INSERT INTO game_configs(game_id,config_key,environment,value,version,updated_at)
       VALUES($1,'feature_flags','production','{"new_feature":true}',3,'2026-08-28T00:00:00.000Z')`,
      [game.id],
    );
    await query(
      `INSERT INTO game_api_keys(game_id,name,key_hash,scopes)
       VALUES($1,'server config key',$2,ARRAY['config:read'])`,
      [game.id, sha256('server-config-key')],
    );
    const otherGame = (await query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('other_game','Other',repeat('b',64)) RETURNING id`,
    )).rows[0]!;
    await query(
      `INSERT INTO game_configs(game_id,config_key,environment,value)
       VALUES($1,'other_game_secret','production','{"hidden":true}')`,
      [otherGame.id],
    );

    const session = await app.inject({
      method: 'POST',
      url: '/api/client/session',
      headers: { 'x-game-id': 'player_config_game' },
      payload: { provider: 'wechat', credential: 'wx-login-code' },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().expires_in, 7200);

    const response = await app.inject({
      method: 'GET',
      url: '/api/client/me/configs?environment=production',
      headers: { authorization: `Bearer ${session.json().user_token}` },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      game_id: 'player_config_game',
      environment: 'production',
      configs: {
        feature_flags: {
          value: { new_feature: true },
          version: 3,
          updated_at: '2026-08-28T00:00:00.000Z',
        },
      },
    });

    const single = await app.inject({
      method: 'GET',
      url: '/api/client/me/configs/feature_flags',
      headers: { authorization: `Bearer ${session.json().user_token}` },
    });
    assert.equal(single.statusCode, 200);
    assert.deepEqual(single.json().value, { new_feature: true });
    assert.equal(single.json().version, 3);
    assert.equal(single.headers['cache-control'], 'private, max-age=60');
    assert.match(String(single.headers.etag), /^"[a-f0-9]{64}"$/);

    const cached = await app.inject({
      method: 'GET',
      url: '/api/client/me/configs/feature_flags',
      headers: {
        authorization: `Bearer ${session.json().user_token}`,
        'if-none-match': String(single.headers.etag),
      },
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.body, '');

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/client/me/configs' });
    assert.equal(unauthenticated.statusCode, 401);

    const crossGame = await app.inject({
      method: 'GET',
      url: '/api/client/me/configs/other_game_secret',
      headers: {
        authorization: `Bearer ${session.json().user_token}`,
        'x-game-id': 'other_game',
      },
    });
    assert.equal(crossGame.statusCode, 404);

    const trustedRoute = await app.inject({
      method: 'GET',
      url: '/api/client/configs/feature_flags',
      headers: {
        'x-game-id': 'player_config_game',
        'x-api-key': 'server-config-key',
      },
    });
    assert.equal(trustedRoute.statusCode, 200);
    assert.deepEqual(trustedRoute.json().value, { new_feature: true });
  } finally {
    await app.close();
    await pool.end();
  }
});
