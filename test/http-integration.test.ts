import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/lib.js';

test('HTTP 接口保持配置发布顺序和游戏成员隔离', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncdepot-http-'));
  process.env.PGLITE_DATA_DIR = dataDir;
  process.env.JWT_SECRET = 'integration-test-secret-that-is-long-enough';
  process.env.NODE_ENV = 'test';

  const { query, transaction, pool } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const { app } = createApp({ query, transaction, pool, databaseMode: 'pglite', env: process.env });
  try {
    for (const name of (await fs.readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await query(await fs.readFile(path.resolve('migrations', name), 'utf8'));
    }
    await query(`INSERT INTO admins(username,password_hash,role) VALUES('root',$1,'admin'),('reader',$2,'viewer')`, [
      hashPassword('root-password'), hashPassword('reader-password'),
    ]);

    const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'root', password: 'root-password' } });
    assert.equal(login.statusCode, 200);
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    const adminToken = login.json().token as string;
    const authorization = { authorization: `Bearer ${adminToken}` };
    const gameResponse = await app.inject({ method: 'POST', url: '/api/admin/games', headers: authorization, payload: { game_key: 'http_game', name: 'HTTP Game' } });
    assert.equal(gameResponse.statusCode, 200);
    const game = gameResponse.json() as { id: string; api_key: string };

    const initialDefinitions = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}/event-definitions`, headers: authorization });
    assert.equal(initialDefinitions.statusCode, 200);
    assert.deepEqual(initialDefinitions.json(), []);
    for (const definition of [
      { event_key: 'level_start', name: '开始关卡', category: 'level' },
      { event_key: 'level_complete', name: '完成关卡', category: 'progression' },
    ]) {
      const created = await app.inject({ method: 'POST', url: `/api/admin/games/${game.id}/event-definitions`, headers: authorization, payload: definition });
      assert.equal(created.statusCode, 200);
    }

    const trackResponse = await app.inject({
      method: 'POST',
      url: '/api/client/events',
      headers: { 'x-game-id': 'http_game', 'x-api-key': game.api_key },
      payload: {
        events: [
          { event_key: 'level_start', session_id: 'player-1', idempotency_key: 'http-start-1', properties: { level: 1 } },
          { event_key: 'level_complete', session_id: 'player-1', idempotency_key: 'http-complete-1', properties: { level: 1 } },
        ],
      },
    });
    assert.equal(trackResponse.statusCode, 200);
    assert.deepEqual(trackResponse.json(), { accepted: 2, duplicated: 0 });

    const resolvedUser = await app.inject({
      method: 'POST',
      url: '/api/client/users/resolve',
      headers: { 'x-game-id': 'http_game', 'x-api-key': game.api_key },
      payload: { user_id: 'analytics-player-1' },
    });
    assert.equal(resolvedUser.statusCode, 200);
    const userToken = resolvedUser.json().user_token as string;
    const userTrackResponse = await app.inject({
      method: 'POST',
      url: '/api/client/me/events',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { events: [{ event_key: 'level_start', idempotency_key: 'user-start-1', properties: { level: 2 } }] },
    });
    assert.equal(userTrackResponse.statusCode, 200);
    assert.deepEqual(userTrackResponse.json(), { accepted: 1, duplicated: 0 });

    const analyticsResponse = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}/analytics?days=7`, headers: authorization });
    assert.equal(analyticsResponse.statusCode, 200);
    assert.equal(analyticsResponse.json().total_events, 3);
    assert.deepEqual(
      analyticsResponse.json().by_event.map((item: { event_key: string; count: number }) => ({ event_key: item.event_key, count: item.count })),
      [
        { event_key: 'level_complete', count: 1 },
        { event_key: 'level_start', count: 2 },
      ],
    );

    const configResponse = await app.inject({ method: 'POST', url: `/api/admin/games/${game.id}/configs`, headers: authorization, payload: { config_key: 'global', value: { n: 1 } } });
    const config = configResponse.json() as { id: string };
    const older = (await app.inject({ method: 'POST', url: `/api/admin/configs/${config.id}/drafts`, headers: authorization, payload: { value: { n: 2 } } })).json();
    const newer = (await app.inject({ method: 'POST', url: `/api/admin/configs/${config.id}/drafts`, headers: authorization, payload: { value: { n: 3 } } })).json();
    await app.inject({ method: 'POST', url: `/api/admin/configs/${config.id}/publish`, headers: authorization, payload: { revision_id: newer.id } });
    await app.inject({ method: 'POST', url: `/api/admin/configs/${config.id}/publish`, headers: authorization, payload: { revision_id: older.id } });

    const clientConfig = await app.inject({
      method: 'GET', url: '/api/client/configs/global',
      headers: { 'x-game-id': 'http_game', 'x-api-key': game.api_key },
    });
    assert.equal(clientConfig.statusCode, 200);
    assert.equal(clientConfig.json().version, 3);
    assert.deepEqual(clientConfig.json().value, { n: 2 });

    const reader = (await query<{ id: string }>(`SELECT id FROM admins WHERE username='reader'`)).rows[0]!;
    await app.inject({ method: 'PUT', url: `/api/admin/games/${game.id}/members/${reader.id}`, headers: authorization, payload: { role: 'viewer' } });
    const readerLogin = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'reader', password: 'reader-password' } });
    const readerToken = readerLogin.json().token as string;
    const visibleGames = await app.inject({ method: 'GET', url: '/api/admin/games', headers: { authorization: `Bearer ${readerToken}` } });
    assert.deepEqual(visibleGames.json().map((item: { id: string }) => item.id), [game.id]);
  } finally {
    await app.close();
    await pool.end();
  }
});
