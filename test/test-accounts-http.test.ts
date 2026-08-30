import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/lib.js';

test('项目测试账号可复用配置、存档和打点链路并支持立即失效', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncdepot-test-accounts-'));
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
      JWT_SECRET: 'test-account-http-secret-that-is-long-enough',
      CLIENT_CORS_ORIGINS: 'http://localhost:7456',
    },
  });

  try {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/client/test-session',
      headers: {
        origin: 'http://localhost:7456',
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'content-type,x-game-id,x-api-key,authorization,idempotency-key,if-none-match',
      },
    });
    assert.equal(preflight.statusCode, 204, preflight.body);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:7456');
    assert.match(String(preflight.headers['access-control-allow-methods']), /POST/);
    assert.match(String(preflight.headers['access-control-allow-methods']), /DELETE/);
    const allowedHeaders = String(preflight.headers['access-control-allow-headers']).toLowerCase();
    for (const header of ['authorization', 'content-type', 'x-game-id', 'x-api-key', 'idempotency-key', 'if-none-match']) {
      assert.match(allowedHeaders, new RegExp(`(?:^|,)\\s*${header}(?:,|$)`));
    }
    const untrustedPreflight = await app.inject({
      method: 'OPTIONS', url: '/api/client/test-session', headers: { origin: 'https://evil.example' },
    });
    assert.equal(untrustedPreflight.headers['access-control-allow-origin'], undefined);
    const adminPreflight = await app.inject({
      method: 'OPTIONS', url: '/api/admin/login', headers: { origin: 'http://localhost:7456' },
    });
    assert.equal(adminPreflight.headers['access-control-allow-origin'], undefined,
      'CORS must stay limited to public client APIs');

    for (const name of (await fs.readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await query(await fs.readFile(path.resolve('migrations', name), 'utf8'));
    }
    await query(
      `INSERT INTO admins(username,password_hash,role) VALUES('test-account-admin',$1,'admin')`,
      [hashPassword('test-account-admin-password')],
    );
    const login = await app.inject({
      method: 'POST', url: '/api/admin/login',
      payload: { username: 'test-account-admin', password: 'test-account-admin-password' },
    });
    const adminHeaders = { authorization: `Bearer ${login.json().token as string}` };
    const gameA = (await app.inject({
      method: 'POST', url: '/api/admin/games', headers: adminHeaders,
      payload: { game_key: 'test_account_game_a', name: 'Test Account A' },
    })).json() as { id: string };
    const gameB = (await app.inject({
      method: 'POST', url: '/api/admin/games', headers: adminHeaders,
      payload: { game_key: 'test_account_game_b', name: 'Test Account B' },
    })).json() as { id: string };
    const config = await app.inject({
      method: 'POST', url: `/api/admin/games/${gameA.id}/configs`, headers: adminHeaders,
      payload: { config_key: 'test_flags', environment: 'development', value: { local_debug: true } },
    });
    assert.equal(config.statusCode, 200, config.body);
    const definition = await app.inject({
      method: 'POST', url: `/api/admin/games/${gameA.id}/event-definitions`, headers: adminHeaders,
      payload: { event_key: 'test_ping', name: '测试打点', category: 'test' },
    });
    assert.equal(definition.statusCode, 200, definition.body);
    const levelDefinition = await app.inject({
      method: 'POST', url: `/api/admin/games/${gameA.id}/event-definitions`, headers: adminHeaders,
      payload: {
        event_key: 'level_result', name: '关卡结果', category: 'level', analysis_type: 'level_result',
        settings: {
          suspected_stuck_failures: 3,
          modes: [{ id: 'custom_mode', display_name: '自定义玩法', fail_reasons: ['blocked'] }],
        },
      },
    });
    assert.equal(levelDefinition.statusCode, 200, levelDefinition.body);

    const created = await app.inject({
      method: 'POST', url: `/api/admin/games/${gameA.id}/test-accounts`, headers: adminHeaders,
      payload: { username: 'local_tester' },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.headers['cache-control'], 'no-store');
    const account = created.json() as { id: string; user_id: string; username: string; password: string };
    assert.equal(account.username, 'local_tester');
    assert.match(account.password, /^test_/);
    assert.doesNotMatch(created.body, /password_hash|scrypt:/);
    const otherAccountResponse = await app.inject({
      method: 'POST', url: `/api/admin/games/${gameB.id}/test-accounts`, headers: adminHeaders,
      payload: { username: 'local_tester' },
    });
    assert.equal(otherAccountResponse.statusCode, 200, otherAccountResponse.body);
    const otherAccount = otherAccountResponse.json() as { user_id: string; password: string };
    assert.notEqual(otherAccount.user_id, account.user_id);
    assert.notEqual(otherAccount.password, account.password);

    const listed = await app.inject({
      method: 'GET', url: `/api/admin/games/${gameA.id}/test-accounts`, headers: adminHeaders,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json()[0].user_id, account.user_id);
    assert.doesNotMatch(listed.body, /password|scrypt:/);

    const wrongGame = await app.inject({
      method: 'POST', url: '/api/client/test-session',
      headers: { 'x-game-id': 'test_account_game_b' },
      payload: { username: account.username, password: account.password },
    });
    assert.equal(wrongGame.statusCode, 401);
    const otherGameSession = await app.inject({
      method: 'POST', url: '/api/client/test-session',
      headers: { 'x-game-id': 'test_account_game_b' },
      payload: { username: account.username, password: otherAccount.password },
    });
    assert.equal(otherGameSession.statusCode, 200, otherGameSession.body);
    assert.equal(otherGameSession.json().id, otherAccount.user_id);
    const session = await app.inject({
      method: 'POST', url: '/api/client/test-session',
      headers: { 'x-game-id': 'test_account_game_a' },
      payload: { username: account.username, password: account.password },
    });
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(session.headers['cache-control'], 'no-store');
    assert.equal(session.json().test_account, true);
    assert.equal(session.json().id, account.user_id);
    const userHeaders = { authorization: `Bearer ${session.json().user_token as string}` };

    const configs = await app.inject({
      method: 'GET', url: '/api/client/me/configs?environment=development', headers: userHeaders,
    });
    assert.equal(configs.statusCode, 200, configs.body);
    assert.deepEqual(configs.json().configs.test_flags.value, { local_debug: true });

    const missingArchive = await app.inject({
      method: 'GET', url: '/api/client/me/archives/local', headers: userHeaders,
    });
    assert.equal(missingArchive.statusCode, 200, missingArchive.body);
    assert.equal(missingArchive.json(), null,
      'a new player without an archive must receive a normal empty response');
    const invalidSlot = await app.inject({
      method: 'PUT', url: `/api/client/me/archives/${'x'.repeat(65)}`,
      headers: userHeaders, payload: { data: {} },
    });
    assert.equal(invalidSlot.statusCode, 400);

    const saved = await app.inject({
      method: 'PUT', url: '/api/client/me/archives/local',
      headers: { ...userHeaders, 'idempotency-key': 'test-account-save-1' },
      payload: { data: { level: 9, from: 'test-account' } },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const loaded = await app.inject({
      method: 'GET', url: '/api/client/me/archives/local', headers: userHeaders,
    });
    assert.deepEqual(loaded.json().data, { level: 9, from: 'test-account' });

    const tracked = await app.inject({
      method: 'POST', url: '/api/client/me/events', headers: userHeaders,
      payload: { events: [{ event_key: 'test_ping', properties: { source: 'local' }, idempotency_key: 'test-ping-1' }] },
    });
    assert.equal(tracked.statusCode, 200, tracked.body);
    assert.deepEqual(tracked.json(), {
      accepted: 1,
      duplicated: 0,
      rejected: 0,
      results: [{ index: 0, eventKey: 'test_ping', status: 'accepted' }],
    });
    const resultEvents = await app.inject({
      method: 'POST', url: '/api/client/me/events', headers: userHeaders,
      payload: {
        events: [1, 2, 3].map(index => ({
          event_key: 'level_result',
          occurred_at: new Date().toISOString(),
          idempotency_key: `test-level-fail-${index}`,
          properties: {
            schema_version: 1,
            mode_id: 'custom_mode',
            level_id: 'custom-level-4',
            level_order: 4,
            result: 'fail',
            fail_reason: 'blocked',
          },
        })),
      },
    });
    assert.equal(resultEvents.statusCode, 200, resultEvents.body);
    assert.equal(resultEvents.json().accepted, 3);
    const productionSummary = await app.inject({
      method: 'GET', url: `/api/admin/games/${gameA.id}/analytics?days=7`, headers: adminHeaders,
    });
    assert.equal(productionSummary.statusCode, 200, productionSummary.body);
    assert.equal(productionSummary.json().total_events, 0);
    const summaryWithTests = await app.inject({
      method: 'GET', url: `/api/admin/games/${gameA.id}/analytics?days=7&include_test=true`, headers: adminHeaders,
    });
    assert.equal(summaryWithTests.statusCode, 200, summaryWithTests.body);
    assert.equal(summaryWithTests.json().total_events, 4);

    const productionLevelAnalysis = await app.inject({
      method: 'GET',
      url: `/api/admin/games/${gameA.id}/analytics/level-results?event_key=level_result&mode_id=custom_mode`,
      headers: adminHeaders,
    });
    assert.equal(productionLevelAnalysis.statusCode, 200, productionLevelAnalysis.body);
    assert.deepEqual(productionLevelAnalysis.json().levels, []);
    const levelAnalysis = await app.inject({
      method: 'GET',
      url: `/api/admin/games/${gameA.id}/analytics/level-results?event_key=level_result&mode_id=custom_mode&include_test=true`,
      headers: adminHeaders,
    });
    assert.equal(levelAnalysis.statusCode, 200, levelAnalysis.body);
    assert.equal(levelAnalysis.json().mode_name, '自定义玩法');
    assert.equal(levelAnalysis.json().levels[0].suspected_stuck_players, 1);
    assert.deepEqual(levelAnalysis.json().current_suspected_stuck_distribution, [{ level_order: 4, players: 1 }]);

    const cleared = await app.inject({
      method: 'DELETE', url: `/api/admin/test-accounts/${account.id}/data`, headers: adminHeaders,
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json(), {
      account_id: account.id,
      user_id: account.user_id,
      archives_deleted: 1,
      events_deleted: 4,
      idempotency_records_deleted: 1,
    });
    const idempotencyAfterClear = await query<{ count: number }>(
      `SELECT count(*)::int count FROM idempotency_records
       WHERE game_id=$1 AND response->>'user_id'=$2`,
      [gameA.id, account.user_id],
    );
    assert.equal(idempotencyAfterClear.rows[0]?.count, 0);
    const listedAfterClear = await app.inject({
      method: 'GET', url: `/api/admin/games/${gameA.id}/test-accounts`, headers: adminHeaders,
    });
    assert.equal(listedAfterClear.json()[0].archive_count, 0);
    assert.equal(listedAfterClear.json()[0].event_count, 0);

    const reset = await app.inject({
      method: 'POST', url: `/api/admin/test-accounts/${account.id}/reset-password`, headers: adminHeaders,
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.headers['cache-control'], 'no-store');
    const nextPassword = reset.json().password as string;
    assert.notEqual(nextPassword, account.password);
    const staleToken = await app.inject({
      method: 'GET', url: '/api/client/me/configs?environment=development', headers: userHeaders,
    });
    assert.equal(staleToken.statusCode, 401);
    const stalePassword = await app.inject({
      method: 'POST', url: '/api/client/test-session', headers: { 'x-game-id': 'test_account_game_a' },
      payload: { username: account.username, password: account.password },
    });
    assert.equal(stalePassword.statusCode, 401);
    const nextSession = await app.inject({
      method: 'POST', url: '/api/client/test-session', headers: { 'x-game-id': 'test_account_game_a' },
      payload: { username: account.username, password: nextPassword },
    });
    assert.equal(nextSession.statusCode, 200, nextSession.body);

    const disabled = await app.inject({
      method: 'PATCH', url: `/api/admin/test-accounts/${account.id}`, headers: adminHeaders,
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().enabled, false);
    const disabledToken = await app.inject({
      method: 'GET', url: '/api/client/me/configs?environment=development',
      headers: { authorization: `Bearer ${nextSession.json().user_token as string}` },
    });
    assert.equal(disabledToken.statusCode, 401);
    const disabledLogin = await app.inject({
      method: 'POST', url: '/api/client/test-session', headers: { 'x-game-id': 'test_account_game_a' },
      payload: { username: account.username, password: nextPassword },
    });
    assert.equal(disabledLogin.statusCode, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});
