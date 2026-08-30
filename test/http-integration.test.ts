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
    const adminPage = await app.inject({ method: 'GET', url: '/' });
    assert.equal(adminPage.statusCode, 200);
    assert.match(String(adminPage.headers['content-security-policy']), /script-src 'self';/);
    assert.doesNotMatch(String(adminPage.headers['content-security-policy']), /script-src 'self' 'unsafe-inline'/);
    const adminScript = await app.inject({ method: 'GET', url: '/admin-core.js' });
    assert.equal(adminScript.statusCode, 200);
    assert.match(String(adminScript.headers['content-type']), /text\/javascript/);
    assert.match(adminScript.body, /function showGames/);
    await query(`INSERT INTO admins(username,password_hash,role) VALUES('root',$1,'admin'),('reader',$2,'viewer')`, [
      hashPassword('root-password'), hashPassword('reader-password'),
    ]);

    const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'root', password: 'root-password' } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.headers['cache-control'], 'no-store');
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    const adminToken = login.json().token as string;
    const authorization = { authorization: `Bearer ${adminToken}` };
    const gameResponse = await app.inject({ method: 'POST', url: '/api/admin/games', headers: authorization, payload: { game_key: 'http_game', name: 'HTTP Game', project_type: 'mini_program' } });
    assert.equal(gameResponse.statusCode, 200);
    assert.equal(gameResponse.headers['cache-control'], 'no-store');
    const game = gameResponse.json() as { id: string; api_key: string; project_type: string };
    assert.equal(game.project_type, 'mini_program');
    const updatedProject = await app.inject({
      method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: authorization,
      payload: { project_type: 'website' },
    });
    assert.equal(updatedProject.statusCode, 200, updatedProject.body);
    assert.equal(updatedProject.json().project_type, 'website');
    const invalidProjectType = await app.inject({
      method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: authorization,
      payload: { project_type: 'unknown_type' },
    });
    assert.equal(invalidProjectType.statusCode, 400);
    const initialKeys = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}/keys`, headers: authorization });
    const initialKey = initialKeys.json()[0] as { id: string };
    const limitedKey = await app.inject({
      method: 'PATCH', url: `/api/admin/keys/${initialKey.id}`, headers: authorization,
      payload: { name: '只读配置密钥', scopes: ['config:read'] },
    });
    assert.equal(limitedKey.statusCode, 200);
    assert.deepEqual(limitedKey.json().scopes, ['config:read']);
    const analyticsKey = await app.inject({
      method: 'POST', url: `/api/admin/games/${game.id}/keys`, headers: authorization,
      payload: { name: '测试完整密钥', scopes: ['config:read', 'user:resolve', 'archive:read', 'archive:write', 'analytics:write'] },
    });
    assert.equal(analyticsKey.headers['cache-control'], 'no-store');
    game.api_key = analyticsKey.json().api_key as string;

    const initialDefinitions = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}/event-definitions`, headers: authorization });
    assert.equal(initialDefinitions.statusCode, 200);
    assert.deepEqual(initialDefinitions.json(), []);
    const batchCreated = await app.inject({
      method: 'POST', url: `/api/admin/games/${game.id}/event-definitions/batch`, headers: authorization,
      payload: {
        definitions: [
          {
            event_key: 'video_ad_click', name: '激励视频入口点击', category: 'rewarded_video', analysis_type: 'count',
            settings: { table: { key: 'video_events', name: '视频事件统计', field: '入口点击', order: 10 } },
          },
          {
            event_key: 'video_ad_show', name: '激励视频曝光', category: 'rewarded_video', analysis_type: 'count',
            settings: { table: { key: 'video_events', name: '视频事件统计', field: '广告曝光', order: 20 } },
          },
        ],
      },
    });
    assert.equal(batchCreated.statusCode, 200, batchCreated.body);
    assert.equal(batchCreated.json().created, 2);
    assert.deepEqual(batchCreated.json().definitions.map((item: { event_key: string }) => item.event_key), [
      'video_ad_click',
      'video_ad_show',
    ]);
    const batchConflict = await app.inject({
      method: 'POST', url: `/api/admin/games/${game.id}/event-definitions/batch`, headers: authorization,
      payload: {
        definitions: [
          { event_key: 'video_ad_reward', name: '激励奖励到账' },
          { event_key: 'video_ad_click', name: '重复事件' },
        ],
      },
    });
    assert.equal(batchConflict.statusCode, 409, batchConflict.body);
    const definitionsAfterConflict = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}/event-definitions`, headers: authorization });
    assert.equal(definitionsAfterConflict.json().some((item: { event_key: string }) => item.event_key === 'video_ad_reward'), false);
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
    assert.deepEqual(trackResponse.json(), {
      accepted: 2,
      duplicated: 0,
      rejected: 0,
      results: [
        { index: 0, eventKey: 'level_start', status: 'accepted' },
        { index: 1, eventKey: 'level_complete', status: 'accepted' },
      ],
    });

    const resolvedUser = await app.inject({
      method: 'POST',
      url: '/api/client/users/resolve',
      headers: { 'x-game-id': 'http_game', 'x-api-key': game.api_key },
      payload: { user_id: 'analytics-player-1' },
    });
    assert.equal(resolvedUser.statusCode, 200);
    assert.equal(resolvedUser.headers['cache-control'], 'no-store');
    const userToken = resolvedUser.json().user_token as string;
    const compressedArchive = String.fromCharCode(120, 156, 0, 255, 12, 34, 0, 7);
    const savedArchive = await app.inject({
      method: 'PUT',
      url: '/api/client/me/archives/main',
      headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': 'http-compressed-archive' },
      payload: { data: compressedArchive },
    });
    assert.equal(savedArchive.statusCode, 200, savedArchive.body);
    assert.equal(savedArchive.json().data, compressedArchive);
    const loadedArchive = await app.inject({
      method: 'GET',
      url: '/api/client/me/archives/main',
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(loadedArchive.statusCode, 200, loadedArchive.body);
    assert.equal(loadedArchive.json().data, compressedArchive);
    const userTrackResponse = await app.inject({
      method: 'POST',
      url: '/api/client/me/events',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { events: [{ event_key: 'level_start', idempotency_key: 'user-start-1', properties: { level: 2 } }] },
    });
    assert.equal(userTrackResponse.statusCode, 200);
    assert.deepEqual(userTrackResponse.json(), {
      accepted: 1,
      duplicated: 0,
      rejected: 0,
      results: [{ index: 0, eventKey: 'level_start', status: 'accepted' }],
    });

    const analyticsResponse = await app.inject({ method: 'GET', url: `/api/admin/games/${game.id}/analytics?days=7`, headers: authorization });
    assert.equal(analyticsResponse.statusCode, 200);
    assert.equal(analyticsResponse.json().total_events, 3);
    assert.deepEqual(
      analyticsResponse.json().by_event.map((item: { event_key: string; count: number }) => ({ event_key: item.event_key, count: item.count })),
      [
        { event_key: 'level_complete', count: 1 },
        { event_key: 'level_start', count: 2 },
        { event_key: 'video_ad_click', count: 0 },
        { event_key: 'video_ad_show', count: 0 },
      ],
    );
    assert.deepEqual(analyticsResponse.json().tables, [{
      table_key: 'video_events',
      table_name: '视频事件统计',
      rows: [
        {
          event_key: 'video_ad_click', field: '入口点击', name: '激励视频入口点击', description: '',
          category: 'rewarded_video', enabled: true, count: 0, unique_actors: 0, average_per_actor: null, order: 10,
        },
        {
          event_key: 'video_ad_show', field: '广告曝光', name: '激励视频曝光', description: '',
          category: 'rewarded_video', enabled: true, count: 0, unique_actors: 0, average_per_actor: null, order: 20,
        },
      ],
    }]);

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

    await query(
      `INSERT INTO game_users(game_id,external_user_id,updated_at) VALUES
       ($1,'page-player-a',now()-interval '1 minute'),
       ($1,'page-player-b',now()-interval '2 minutes'),
       ($1,'page-player-c',now()-interval '3 minutes')`,
      [game.id],
    );
    const firstUsersPage = await app.inject({
      method: 'GET', url: `/api/admin/games/${game.id}/users?limit=2`, headers: authorization,
    });
    assert.equal(firstUsersPage.statusCode, 200, firstUsersPage.body);
    assert.equal(firstUsersPage.json().items.length, 2);
    assert.equal(typeof firstUsersPage.json().next_cursor, 'string');
    const secondUsersPage = await app.inject({
      method: 'GET',
      url: `/api/admin/games/${game.id}/users?limit=2&cursor=${encodeURIComponent(firstUsersPage.json().next_cursor as string)}`,
      headers: authorization,
    });
    const pageIds = [
      ...firstUsersPage.json().items.map((item: { id: string }) => item.id),
      ...secondUsersPage.json().items.map((item: { id: string }) => item.id),
    ];
    assert.equal(new Set(pageIds).size, pageIds.length);

    const createdAccount = await app.inject({
      method: 'POST', url: '/api/admin/admins', headers: authorization,
      payload: { username: 'new-member', password: 'temporary-password', role: 'viewer' },
    });
    assert.equal(createdAccount.statusCode, 200);
    assert.equal(createdAccount.json().must_change_password, true);
    const invalidAccountRole = await app.inject({
      method: 'POST', url: '/api/admin/admins', headers: authorization,
      payload: { username: 'unsafe-role', password: 'temporary-password', role: 'typo-admin' },
    });
    assert.equal(invalidAccountRole.statusCode, 400);
    const missingAccountRole = await app.inject({
      method: 'POST', url: '/api/admin/admins', headers: authorization,
      payload: { username: 'missing-role', password: 'temporary-password' },
    });
    assert.equal(missingAccountRole.statusCode, 400);
    const invalidProjectName = await app.inject({
      method: 'PATCH', url: `/api/admin/games/${game.id}`, headers: authorization,
      payload: { name: '' },
    });
    assert.equal(invalidProjectName.statusCode, 400);
    const invalidUserId = await app.inject({
      method: 'GET', url: '/api/admin/users/not-a-uuid/archives', headers: authorization,
    });
    assert.equal(invalidUserId.statusCode, 400);
    const firstLogin = await app.inject({
      method: 'POST', url: '/api/admin/login',
      payload: { username: 'new-member', password: 'temporary-password' },
    });
    const firstToken = firstLogin.json().token as string;
    assert.equal(firstLogin.json().user.must_change_password, true);
    const blockedBeforeChange = await app.inject({
      method: 'GET', url: '/api/admin/games', headers: { authorization: `Bearer ${firstToken}` },
    });
    assert.equal(blockedBeforeChange.statusCode, 403);
    assert.equal(blockedBeforeChange.json().code, 'PASSWORD_CHANGE_REQUIRED');
    const changedPassword = await app.inject({
      method: 'PUT', url: '/api/admin/me/password', headers: { authorization: `Bearer ${firstToken}` },
      payload: { current_password: 'temporary-password', new_password: 'member-new-password' },
    });
    assert.equal(changedPassword.statusCode, 200, changedPassword.body);
    assert.equal(changedPassword.headers['cache-control'], 'no-store');
    assert.equal(changedPassword.json().user.must_change_password, false);
    const staleLogin = await app.inject({
      method: 'GET', url: '/api/admin/me', headers: { authorization: `Bearer ${firstToken}` },
    });
    assert.equal(staleLogin.statusCode, 401);
    const activeLogin = await app.inject({
      method: 'GET', url: '/api/admin/me',
      headers: { authorization: `Bearer ${changedPassword.json().token as string}` },
    });
    assert.equal(activeLogin.statusCode, 200);
    const newMemberId = createdAccount.json().id as string;
    const promoteReader = await app.inject({
      method: 'PUT', url: `/api/admin/games/${game.id}/members/${reader.id}`, headers: authorization,
      payload: { role: 'owner' },
    });
    assert.equal(promoteReader.statusCode, 200);
    const ownerAddsMember = await app.inject({
      method: 'PUT', url: `/api/admin/games/${game.id}/members/${newMemberId}`,
      headers: { authorization: `Bearer ${readerToken}` }, payload: { role: 'editor' },
    });
    assert.equal(ownerAddsMember.statusCode, 200, ownerAddsMember.body);
    const rotatedKey = await app.inject({
      method: 'POST', url: `/api/admin/games/${game.id}/rotate-key`, headers: authorization,
    });
    assert.equal(rotatedKey.statusCode, 200, rotatedKey.body);
    assert.equal(rotatedKey.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
    await pool.end();
  }
});
