import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/lib.js';

test('管理员为每个游戏独立配置微信登录且接口不回传 AppSecret', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncdepot-game-credentials-http-'));
  process.env.PGLITE_DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  const originalFetch = globalThis.fetch;
  const wechatRequests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    wechatRequests.push(url);
    return Response.json({ openid: `openid-${url.searchParams.get('appid')}` });
  };

  const { query, transaction, pool } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const { app } = createApp({
    query,
    transaction,
    pool,
    databaseMode: 'pglite',
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'game-credentials-http-jwt-secret-0001',
      CREDENTIAL_ENCRYPTION_KEY: 'game-credentials-http-encryption-key-0001',
    },
  });

  try {
    for (const name of (await fs.readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await query(await fs.readFile(path.resolve('migrations', name), 'utf8'));
    }
    await query(
      `INSERT INTO admins(username,password_hash,role) VALUES('credential-admin',$1,'admin')`,
      [hashPassword('credential-admin-password')],
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { username: 'credential-admin', password: 'credential-admin-password' },
    });
    const adminHeaders = { authorization: `Bearer ${login.json().token as string}` };
    const gameA = (await app.inject({
      method: 'POST', url: '/api/admin/games', headers: adminHeaders,
      payload: { game_key: 'http_wechat_a', name: 'HTTP WeChat A' },
    })).json() as { id: string };
    const gameB = (await app.inject({
      method: 'POST', url: '/api/admin/games', headers: adminHeaders,
      payload: { game_key: 'http_wechat_b', name: 'HTTP WeChat B' },
    })).json() as { id: string };

    const savedA = await app.inject({
      method: 'PUT',
      url: `/api/admin/games/${gameA.id}/wechat-credentials`,
      headers: adminHeaders,
      payload: { app_id: 'wx-http-a', app_secret: 'http-secret-a' },
    });
    const savedB = await app.inject({
      method: 'PUT',
      url: `/api/admin/games/${gameB.id}/wechat-credentials`,
      headers: adminHeaders,
      payload: { app_id: 'wx-http-b', app_secret: 'http-secret-b' },
    });
    assert.equal(savedA.statusCode, 200);
    assert.equal(savedB.statusCode, 200);
    assert.deepEqual(
      Object.keys(savedA.json()).sort(),
      ['app_id', 'configured', 'provider', 'updated_at'],
    );
    assert.doesNotMatch(savedA.body + savedB.body, /http-secret|ciphertext|app_secret/);

    const status = await app.inject({
      method: 'GET', url: `/api/admin/games/${gameA.id}/wechat-credentials`, headers: adminHeaders,
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().app_id, 'wx-http-a');
    assert.equal(status.json().configured, true);
    assert.doesNotMatch(status.body, /http-secret|ciphertext|app_secret/);

    const stored = await query<{ secret_ciphertext: string }>(
      `SELECT secret_ciphertext FROM game_platform_credentials ORDER BY app_id`,
    );
    assert.equal(stored.rows.length, 2);
    assert.doesNotMatch(JSON.stringify(stored.rows), /http-secret-a|http-secret-b/);
    const games = await app.inject({ method: 'GET', url: '/api/admin/games', headers: adminHeaders });
    assert.doesNotMatch(games.body, /http-secret|ciphertext|app_secret/);

    for (const [gameKey, code] of [['http_wechat_a', 'code-a'], ['http_wechat_b', 'code-b']]) {
      const session = await app.inject({
        method: 'POST',
        url: '/api/client/session',
        headers: { 'x-game-id': gameKey },
        payload: { provider: 'wechat', credential: code },
      });
      assert.equal(session.statusCode, 200, session.body);
    }
    assert.equal(wechatRequests[0]?.searchParams.get('appid'), 'wx-http-a');
    assert.equal(wechatRequests[0]?.searchParams.get('secret'), 'http-secret-a');
    assert.equal(wechatRequests[1]?.searchParams.get('appid'), 'wx-http-b');
    assert.equal(wechatRequests[1]?.searchParams.get('secret'), 'http-secret-b');

    const missingSecret = await app.inject({
      method: 'PUT',
      url: `/api/admin/games/${gameA.id}/wechat-credentials`,
      headers: adminHeaders,
      payload: { app_id: 'wx-http-a-changed' },
    });
    assert.equal(missingSecret.statusCode, 400);
    assert.match(missingSecret.json().error, /重新填写 AppSecret/);

    const auditRows = await query<{ before_data: unknown; after_data: unknown }>(
      `SELECT before_data,after_data FROM audit_logs WHERE action='game.wechat_credentials.update'`,
    );
    assert.equal(auditRows.rows.length, 2);
    assert.doesNotMatch(JSON.stringify(auditRows.rows), /http-secret|ciphertext|app_secret/);

    const removed = await app.inject({
      method: 'DELETE', url: `/api/admin/games/${gameA.id}/wechat-credentials`, headers: adminHeaders,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().configured, false);
    const unavailable = await app.inject({
      method: 'POST', url: '/api/client/session', headers: { 'x-game-id': 'http_wechat_a' },
      payload: { provider: 'wechat', credential: 'code-after-remove' },
    });
    assert.equal(unavailable.statusCode, 503);
  } finally {
    await app.close();
    await pool.end();
    globalThis.fetch = originalFetch;
  }
});
