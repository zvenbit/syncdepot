import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsModule, type AnalyticsEvent } from '../src/modules/analytics.js';
import { createTestDatabase } from './support/database.js';

const occurredAt = new Date().toISOString();

function levelEvent(
  userId: string,
  idempotencyKey: string,
  properties: Record<string, unknown>,
): AnalyticsEvent {
  return { eventKey: 'level_result', userId, idempotencyKey, occurredAt, properties };
}

test('运营打点支持定义事件、批量幂等上报和按事件汇总', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('analytics_game','Analytics Game',repeat('8',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);

    await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'video_ad_click',
      name: '激励视频点击',
      category: 'video_ad',
      description: '玩家点击激励视频入口',
    });
    await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'video_ad_play_success',
      name: '激励视频播放成功',
      category: 'video_ad',
    });

    const recorded = await analytics.recordEvents({
      gameId: game.id,
      events: [
        { eventKey: 'video_ad_click', sessionId: 'session-a', idempotencyKey: 'click-a', properties: { placement: 'revive' } },
        { eventKey: 'video_ad_click', sessionId: 'session-b', idempotencyKey: 'click-b' },
        { eventKey: 'video_ad_play_success', sessionId: 'session-a', idempotencyKey: 'success-a' },
      ],
    });
    const duplicate = await analytics.recordEvents({
      gameId: game.id,
      events: [{ eventKey: 'video_ad_click', sessionId: 'session-a', idempotencyKey: 'click-a' }],
    });
    const summary = await analytics.getSummary({ gameId: game.id, days: 7 });

    assert.deepEqual(
      { accepted: recorded.accepted, duplicated: recorded.duplicated, rejected: recorded.rejected },
      { accepted: 3, duplicated: 0, rejected: 0 },
    );
    assert.deepEqual(recorded.results.map(item => item.status), ['accepted', 'accepted', 'accepted']);
    assert.deepEqual(
      { accepted: duplicate.accepted, duplicated: duplicate.duplicated, rejected: duplicate.rejected },
      { accepted: 0, duplicated: 1, rejected: 0 },
    );
    assert.equal(summary.totalEvents, 3);
    assert.equal(summary.uniqueActors, 2);
    assert.deepEqual(
      summary.byEvent.map(item => ({ eventKey: item.eventKey, count: item.count, uniqueActors: item.uniqueActors })),
      [
        { eventKey: 'video_ad_click', count: 2, uniqueActors: 2 },
        { eventKey: 'video_ad_play_success', count: 1, uniqueActors: 1 },
      ],
    );
  } finally {
    await database.close();
  }
});

test('事件定义支持事务式批量创建并在冲突时整批回滚', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('definition_batch','Definition Batch',repeat('7',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    const created = await analytics.defineEvents({
      gameId: game.id,
      definitions: [
        { eventKey: 'video_ad_click', name: '激励视频入口点击', category: 'rewarded_video' },
        { eventKey: 'video_ad_show', name: '激励视频曝光', category: 'rewarded_video' },
      ],
    });
    assert.deepEqual(created.map(item => item.event_key), ['video_ad_click', 'video_ad_show']);

    await assert.rejects(
      analytics.defineEvents({
        gameId: game.id,
        definitions: [
          { eventKey: 'video_ad_reward', name: '激励奖励到账' },
          { eventKey: 'video_ad_click', name: '重复事件' },
        ],
      }),
      error => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal((error as { code?: string }).code, 'EVENT_KEY_EXISTS');
        return true;
      },
    );
    assert.deepEqual((await analytics.listDefinitions(game.id)).map(item => item.event_key), [
      'video_ad_click',
      'video_ad_show',
    ]);

    await assert.rejects(
      analytics.defineEvents({
        gameId: game.id,
        definitions: [
          { eventKey: 'video_ad_fail', name: '视频失败' },
          { eventKey: 'video_ad_fail', name: '重复的视频失败' },
        ],
      }),
      /event_key 重复/,
    );
    assert.equal((await analytics.listDefinitions(game.id)).some(item => item.event_key === 'video_ad_fail'), false);
  } finally {
    await database.close();
  }
});

test('普通事件可以按通用组合表格字段汇总且不依赖业务事件名称', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('generic_tables','Generic Tables',repeat('1',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    await analytics.defineEvents({
      gameId: game.id,
      definitions: [
        {
          eventKey: 'alpha_open', name: '打开', category: 'any',
          settings: { table: { key: 'generic_flow', name: '任意流程', field: '开始', order: 20 } },
        },
        {
          eventKey: 'alpha_finish', name: '完成', category: 'any',
          settings: { table: { key: 'generic_flow', name: '任意流程', field: '完成', order: 10 } },
        },
        { eventKey: 'standalone_event', name: '单独事件' },
      ],
    });
    await analytics.recordEvents({
      gameId: game.id,
      events: [
        { eventKey: 'alpha_open', sessionId: 'actor-a', idempotencyKey: 'open-1' },
        { eventKey: 'alpha_open', sessionId: 'actor-a', idempotencyKey: 'open-2' },
        { eventKey: 'alpha_finish', sessionId: 'actor-a', idempotencyKey: 'finish-1' },
        { eventKey: 'standalone_event', sessionId: 'actor-b', idempotencyKey: 'standalone-1' },
      ],
    });

    const summary = await analytics.getSummary({ gameId: game.id, days: 7 });
    assert.deepEqual(summary.tables, [{
      key: 'generic_flow',
      name: '任意流程',
      rows: [
        {
          eventKey: 'alpha_finish', field: '完成', name: '完成', description: '', category: 'any', enabled: true,
          count: 1, uniqueActors: 1, averagePerActor: 1, order: 10,
        },
        {
          eventKey: 'alpha_open', field: '开始', name: '打开', description: '', category: 'any', enabled: true,
          count: 2, uniqueActors: 1, averagePerActor: 2, order: 20,
        },
      ],
    }]);
    assert.equal(summary.tables[0]!.rows.some(row => row.eventKey === 'standalone_event'), false);

    await assert.rejects(
      analytics.defineEvent({
        gameId: game.id,
        eventKey: 'alpha_error',
        name: '错误',
        settings: { table: { key: 'generic_flow', name: '另一个名称', field: '错误', order: 30 } },
      }),
      error => (error as { code?: string }).code === 'TABLE_NAME_CONFLICT',
    );
    await assert.rejects(
      analytics.defineEvent({
        gameId: game.id,
        eventKey: 'alpha_duplicate_field',
        name: '重复字段',
        settings: { table: { key: 'generic_flow', name: '任意流程', field: '开始', order: 30 } },
      }),
      error => (error as { code?: string }).code === 'TABLE_FIELD_EXISTS',
    );
  } finally {
    await database.close();
  }
});

test('并发创建事件时同一组合表字段只能被一个事件占用', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('table_concurrency','Table Concurrency',repeat('2',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    const attempts = await Promise.allSettled([
      analytics.defineEvent({
        gameId: game.id,
        eventKey: 'concurrent_open',
        name: '并发打开',
        settings: { table: { key: 'concurrent_flow', name: '并发流程', field: '同一字段', order: 10 } },
      }),
      analytics.defineEvent({
        gameId: game.id,
        eventKey: 'concurrent_finish',
        name: '并发完成',
        settings: { table: { key: 'concurrent_flow', name: '并发流程', field: '同一字段', order: 20 } },
      }),
    ]);

    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    const rejected = attempts.find(item => item.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' && (rejected.reason as { code?: string }).code, 'TABLE_FIELD_EXISTS');
  } finally {
    await database.close();
  }
});

test('属性分析按项目自定义字段统计数值和枚举并默认排除测试账号', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('property_analysis','Property Analysis',repeat('4',64)) RETURNING id`,
    )).rows[0]!;
    const users = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES
       ($1,'player-one'),($1,'player-two'),($1,'test-player') RETURNING id`,
      [game.id],
    )).rows;
    await database.query(
      `INSERT INTO game_test_accounts(id,game_id,user_id,username,password_hash)
       VALUES(gen_random_uuid(),$1,$2,'tester','hash')`,
      [game.id, users[2]!.id],
    );
    const analytics = createAnalyticsModule(database);
    const definition = await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'player_snapshot',
      name: '玩家状态快照',
      analysisType: 'property',
      settings: {
        fields: [
          { key: 'stats.power', description: '战力', type: 'number' },
          { key: 'mode', description: '当前模式', type: 'dimension', limit: 2 },
        ],
      },
    });
    assert.deepEqual(definition.settings.fields, [
      { key: 'stats.power', description: '战力', type: 'number' },
      { key: 'mode', description: '当前模式', type: 'dimension', limit: 2 },
    ]);
    await analytics.recordEvents({
      gameId: game.id,
      events: [
        { eventKey: 'player_snapshot', userId: users[0]!.id, properties: { stats: { power: 100 }, mode: 'story' } },
        { eventKey: 'player_snapshot', userId: users[0]!.id, properties: { stats: { power: 150 }, mode: 'story' } },
        { eventKey: 'player_snapshot', userId: users[1]!.id, properties: { stats: { power: 'bad' }, mode: 'challenge' } },
        { eventKey: 'player_snapshot', userId: users[1]!.id, properties: { stats: { power: 50 }, mode: 'event' } },
        { eventKey: 'player_snapshot', userId: users[2]!.id, properties: { stats: { power: 999 }, mode: 'test' } },
      ],
    });

    const result = await analytics.getPropertyAnalysis({ gameId: game.id, eventKey: 'player_snapshot' });
    assert.deepEqual(result.fields[0], {
      key: 'stats.power', description: '战力', type: 'number', presentCount: 4, validCount: 3,
      invalidCount: 1, uniqueActors: 2, minimum: 50, maximum: 150, average: 100, sum: 300,
    });
    assert.deepEqual(result.fields[1], {
      key: 'mode', description: '当前模式', type: 'dimension', presentCount: 4, validCount: 4,
      invalidCount: 0, uniqueActors: 2, truncated: true,
      values: [
        { value: 'story', count: 2, uniqueActors: 1 },
        { value: 'challenge', count: 1, uniqueActors: 1 },
      ],
    });
    const withTest = await analytics.getPropertyAnalysis({
      gameId: game.id, eventKey: 'player_snapshot', includeTest: true,
    });
    assert.equal(withTest.fields[0]!.maximum, 999);
    assert.equal(withTest.fields[0]!.validCount, 4);
  } finally {
    await database.close();
  }
});

test('批量上报逐条拒绝非法事件而不阻塞合法事件', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('analytics_partial','Analytics Partial',repeat('9',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    await analytics.defineEvent({ gameId: game.id, eventKey: 'video_ad_click', name: '视频点击' });

    const result = await analytics.recordEvents({
      gameId: game.id,
      events: [
        { eventKey: 'unknown', sessionId: 'session-a' },
        { eventKey: 'video_ad_click', sessionId: 'session-b', idempotencyKey: 'valid-click' },
        { eventKey: 'video_ad_click' },
      ],
    });

    assert.deepEqual(
      { accepted: result.accepted, duplicated: result.duplicated, rejected: result.rejected },
      { accepted: 1, duplicated: 0, rejected: 2 },
    );
    assert.deepEqual(result.results.map(item => item.status), ['rejected', 'accepted', 'rejected']);
    assert.deepEqual(result.results.filter(item => item.status === 'rejected').map(item => item.code), [
      'EVENT_NOT_DEFINED',
      'MISSING_ACTOR',
    ]);
    assert.equal(Number((await database.query<{ count: string | number }>(
      `SELECT count(*) count FROM game_events WHERE game_id=$1`, [game.id],
    )).rows[0]!.count), 1);
  } finally {
    await database.close();
  }
});

test('可信服务不能把其他项目的玩家写入当前项目运营数据', async () => {
  const database = await createTestDatabase();
  try {
    const games = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES
       ('analytics_owner','Owner Game',repeat('2',64)),
       ('analytics_other','Other Game',repeat('3',64)) RETURNING id`,
    )).rows;
    const ownerGame = games[0]!;
    const otherGame = games[1]!;
    const otherUser = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'other-player') RETURNING id`,
      [otherGame.id],
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    await analytics.defineEvent({ gameId: ownerGame.id, eventKey: 'video_ad_click', name: '视频点击' });

    const result = await analytics.recordEvents({
      gameId: ownerGame.id,
      events: [{ eventKey: 'video_ad_click', userId: otherUser.id }],
    });
    assert.equal(result.rejected, 1);
    assert.equal(result.results[0]!.code, 'PLAYER_NOT_IN_GAME');
  } finally {
    await database.close();
  }
});

test('每个项目可以编辑、启停和删除自己的事件定义', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('custom_events','Custom Events',repeat('4',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    const created = await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'level_complete',
      name: '关卡完成',
      category: 'level',
    });

    const disabled = await analytics.updateDefinition({
      definitionId: created.id,
      name: '完成任意关卡',
      category: 'progression',
      description: '结算成功时触发',
      enabled: false,
    });
    assert.equal(disabled.name, '完成任意关卡');
    assert.equal(disabled.category, 'progression');
    assert.equal(disabled.enabled, false);
    const rejected = await analytics.recordEvents({
      gameId: game.id,
      events: [{ eventKey: 'level_complete', sessionId: 'player-1' }],
    });
    assert.equal(rejected.results[0]!.code, 'EVENT_NOT_DEFINED');

    await analytics.removeDefinition(created.id);
    assert.deepEqual(await analytics.listDefinitions(game.id), []);
  } finally {
    await database.close();
  }
});

test('已有历史数据的事件定义不能删除但可以停用', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('event_history','Event History',repeat('5',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    const created = await analytics.defineEvent({ gameId: game.id, eventKey: 'purchase', name: '完成购买' });
    await analytics.recordEvents({ gameId: game.id, events: [{ eventKey: 'purchase', sessionId: 'player-1' }] });

    await assert.rejects(analytics.removeDefinition(created.id), /已有历史数据/);
    const disabled = await analytics.updateDefinition({ definitionId: created.id, enabled: false });
    assert.equal(disabled.enabled, false);
  } finally {
    await database.close();
  }
});

test('关卡结果按自定义玩法统计成功、失败、最高进度和疑似卡关', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('level_results','Level Results',repeat('6',64)) RETURNING id`,
    )).rows[0]!;
    const players = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES
       ($1,'player-1'),($1,'player-2'),($1,'player-3') RETURNING id`,
      [game.id],
    )).rows;
    const [player1, player2, player3] = players;
    const analytics = createAnalyticsModule(database);
    const definition = await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'level_result',
      name: '关卡结果',
      category: 'level',
      analysisType: 'level_result',
      settings: {
        suspected_stuck_failures: 3,
        collection_started_at: new Date(Date.now() - 60_000).toISOString(),
        modes: [
          { id: 'mode_a', display_name: '测试玩法 A', fail_reasons: ['test_failure_a', 'other_failure'] },
          { id: 'mode_b', display_name: '测试玩法 B', fail_reasons: ['test_failure_b', 'other_failure'] },
        ],
      },
    });
    assert.equal(definition.analysis_type, 'level_result');
    assert.deepEqual((definition.settings.modes as unknown[]).map(item => (item as { id: string }).id), ['mode_a', 'mode_b']);

    const events: AnalyticsEvent[] = [];
    for (let index = 1; index <= 3; index += 1) {
      events.push(levelEvent(player1!.id, `p1-a6-f${index}`, {
        schema_version: 1, mode_id: 'mode_a', level_id: 'mode-a-006', level_order: 6, result: 'fail', fail_reason: 'test_failure_a',
      }));
      events.push(levelEvent(player2!.id, `p2-a6-f${index}`, {
        schema_version: 1, mode_id: 'mode_a', level_id: 'mode-a-006', level_order: 6, result: 'fail', fail_reason: 'test_failure_a',
      }));
    }
    events.push(
      levelEvent(player1!.id, 'p1-a6-s1', { schema_version: 1, mode_id: 'mode_a', level_id: 'mode-a-006', level_order: 6, result: 'success' }),
      levelEvent(player1!.id, 'p1-a6-s2', { schema_version: 1, mode_id: 'mode_a', level_id: 'mode-a-006', level_order: 6, result: 'success' }),
      levelEvent(player1!.id, 'p1-a7-f1', { schema_version: 1, mode_id: 'mode_a', level_id: 'mode-a-007', level_order: 7, result: 'fail', fail_reason: 'test_failure_a' }),
      levelEvent(player3!.id, 'p3-b3-f1', { schema_version: 1, mode_id: 'mode_b', level_id: 'mode-b-003', level_order: 3, result: 'fail', fail_reason: 'test_failure_b' }),
    );
    const recorded = await analytics.recordEvents({ gameId: game.id, events });
    assert.equal(recorded.accepted, 10);
    assert.equal(recorded.rejected, 0);

    const duplicate = await analytics.recordEvents({ gameId: game.id, events: [events[0]!] });
    assert.equal(duplicate.duplicated, 1);
    const modeAResult = await analytics.getLevelResultAnalysis({ gameId: game.id, eventKey: 'level_result', modeId: 'mode_a' });
    assert.equal(modeAResult.modeName, '测试玩法 A');
    assert.equal(modeAResult.suspectedStuckFailures, 3);
    assert.deepEqual(modeAResult.levels, [
      {
        levelId: 'mode-a-006', levelOrder: 6, resultPlayers: 2,
        successPlayers: 1, successEvents: 2, failedPlayers: 2, failureEvents: 6,
        unresolvedFailedPlayers: 1, suspectedStuckPlayers: 1,
        playerCompletionRate: 0.5, resultFailureRatio: 0.75, failuresPerResultPlayer: 3,
      },
      {
        levelId: 'mode-a-007', levelOrder: 7, resultPlayers: 1,
        successPlayers: 0, successEvents: 0, failedPlayers: 1, failureEvents: 1,
        unresolvedFailedPlayers: 1, suspectedStuckPlayers: 0,
        playerCompletionRate: 0, resultFailureRatio: 1, failuresPerResultPlayer: 1,
      },
    ]);
    assert.deepEqual(modeAResult.highestResultDistribution, [{ levelOrder: 6, players: 1 }, { levelOrder: 7, players: 1 }]);
    assert.deepEqual(modeAResult.highestSuccessDistribution, [{ levelOrder: 6, players: 1 }]);
    assert.deepEqual(modeAResult.currentSuspectedStuckDistribution, [{ levelOrder: 6, players: 1 }]);

    const modeBResult = await analytics.getLevelResultAnalysis({ gameId: game.id, eventKey: 'level_result', modeId: 'mode_b' });
    assert.equal(modeBResult.levels[0]!.failureEvents, 1);
    assert.equal(modeBResult.levels[0]!.successPlayers, 0);
    assert.equal(Number((await database.query<{ count: string | number }>(
      `SELECT count(*) count FROM level_result_events WHERE game_id=$1`, [game.id],
    )).rows[0]!.count), 10);
  } finally {
    await database.close();
  }
});

test('关卡结果强制稳定玩家、幂等键、时间和项目玩法校验', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('level_validation','Level Validation',repeat('7',64)) RETURNING id`,
    )).rows[0]!;
    const player = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'player') RETURNING id`, [game.id],
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'level_result',
      name: '关卡结果',
      analysisType: 'level_result',
      settings: { suspected_stuck_failures: 3, modes: [{ id: 'main', display_name: '主线', fail_reasons: ['timeout'] }] },
    });
    const validProperties = { schema_version: 1, mode_id: 'main', level_id: 'main-001', level_order: 1, result: 'fail', fail_reason: 'timeout' };
    const result = await analytics.recordEvents({
      gameId: game.id,
      events: [
        { eventKey: 'level_result', sessionId: 'temporary', occurredAt, idempotencyKey: 'session-only', properties: validProperties },
        { eventKey: 'level_result', userId: player.id, idempotencyKey: 'missing-time', properties: validProperties },
        { eventKey: 'level_result', userId: player.id, occurredAt, properties: validProperties },
        levelEvent(player.id, 'bad-schema', { ...validProperties, schema_version: 2 }),
        levelEvent(player.id, 'bad-mode', { ...validProperties, mode_id: 'other' }),
        levelEvent(player.id, 'bad-order', { ...validProperties, level_order: 0 }),
        levelEvent(player.id, 'bad-result', { ...validProperties, result: 'quit' }),
        levelEvent(player.id, 'missing-reason', { ...validProperties, fail_reason: undefined }),
        levelEvent(player.id, 'bad-reason', { ...validProperties, fail_reason: 'test_invalid_reason' }),
        levelEvent(player.id, 'x'.repeat(192), validProperties),
      ],
    });
    assert.equal(result.accepted, 0);
    assert.equal(result.rejected, 10);
    assert.deepEqual(result.results.map(item => item.code), [
      'LEVEL_RESULT_REQUIRES_PLAYER',
      'MISSING_OCCURRED_AT',
      'MISSING_IDEMPOTENCY_KEY',
      'INVALID_SCHEMA_VERSION',
      'INVALID_MODE_ID',
      'INVALID_LEVEL_ORDER',
      'INVALID_LEVEL_RESULT',
      'MISSING_FAIL_REASON',
      'INVALID_FAIL_REASON',
      'INVALID_IDEMPOTENCY_KEY',
    ]);
  } finally {
    await database.close();
  }
});

test('关卡分析只统计完整采集开始时间之后发生的结果', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('collection_boundary','Collection Boundary',repeat('b',64)) RETURNING id`,
    )).rows[0]!;
    const player = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'player') RETURNING id`, [game.id],
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    const collectionStartedAt = new Date().toISOString();
    await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'level_result',
      name: '关卡结果',
      analysisType: 'level_result',
      settings: {
        suspected_stuck_failures: 3,
        collection_started_at: collectionStartedAt,
        modes: [{ id: 'main', display_name: '主线', fail_reasons: [] }],
      },
    });
    const properties = {
      schema_version: 1, mode_id: 'main', level_id: 'main-001', level_order: 1, result: 'fail',
    };
    const result = await analytics.recordEvents({
      gameId: game.id,
      events: [
        {
          eventKey: 'level_result', userId: player.id, idempotencyKey: 'before-collection',
          occurredAt: new Date(Date.now() - 60_000).toISOString(), properties,
        },
        {
          eventKey: 'level_result', userId: player.id, idempotencyKey: 'after-collection',
          occurredAt: new Date(Date.now() + 1_000).toISOString(), properties,
        },
      ],
    });
    assert.equal(result.accepted, 2);

    const analysis = await analytics.getLevelResultAnalysis({
      gameId: game.id, eventKey: 'level_result', modeId: 'main',
    });
    assert.equal(analysis.levels[0]!.failureEvents, 1);
  } finally {
    await database.close();
  }
});

test('已有结果数据的玩法标识不能从事件定义中移除', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('mode_lock','Mode Lock',repeat('a',64)) RETURNING id`,
    )).rows[0]!;
    const player = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'player') RETURNING id`, [game.id],
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);
    const definition = await analytics.defineEvent({
      gameId: game.id,
      eventKey: 'level_result',
      name: '关卡结果',
      analysisType: 'level_result',
      settings: {
        suspected_stuck_failures: 3,
        modes: [
          { id: 'main', display_name: '主线', fail_reasons: [] },
          { id: 'challenge', display_name: '挑战', fail_reasons: [] },
        ],
      },
    });
    await analytics.recordEvents({
      gameId: game.id,
      events: [levelEvent(player.id, 'main-success', {
        schema_version: 1, mode_id: 'main', level_id: 'main-001', level_order: 1, result: 'success',
      })],
    });

    await assert.rejects(analytics.updateDefinition({
      definitionId: definition.id,
      settings: {
        suspected_stuck_failures: 4,
        collection_started_at: (definition.settings.collection_started_at as string),
        modes: [{ id: 'challenge', display_name: '挑战模式', fail_reasons: [] }],
      },
    }), /已有结果数据/);
  } finally {
    await database.close();
  }
});
