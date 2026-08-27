import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalyticsModule } from '../src/modules/analytics.js';
import { createTestDatabase } from './support/database.js';

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

    assert.deepEqual(recorded, { accepted: 3, duplicated: 0 });
    assert.deepEqual(duplicate, { accepted: 0, duplicated: 1 });
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

test('运营打点拒绝未定义事件和缺少玩家标识的上报', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('analytics_invalid','Analytics Game',repeat('9',64)) RETURNING id`,
    )).rows[0]!;
    const analytics = createAnalyticsModule(database);

    await assert.rejects(
      analytics.recordEvents({ gameId: game.id, events: [{ eventKey: 'unknown', sessionId: 'session-a' }] }),
      /未定义或已停用/,
    );
    await analytics.defineEvent({ gameId: game.id, eventKey: 'video_ad_click', name: '视频点击' });
    await assert.rejects(
      analytics.recordEvents({ gameId: game.id, events: [{ eventKey: 'video_ad_click' }] }),
      /userId 或 sessionId/,
    );
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

    await assert.rejects(
      analytics.recordEvents({ gameId: ownerGame.id, events: [{ eventKey: 'video_ad_click', userId: otherUser.id }] }),
      /玩家不属于当前项目/,
    );
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
    await assert.rejects(
      analytics.recordEvents({ gameId: game.id, events: [{ eventKey: 'level_complete', sessionId: 'player-1' }] }),
      /未定义或已停用/,
    );

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
