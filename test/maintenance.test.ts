import test from 'node:test';
import assert from 'node:assert/strict';
import { runRetention } from '../src/maintenance.js';
import { createTestDatabase } from './support/database.js';

test('保留任务清理过期幂等记录和共享限流桶', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('retention_game','Retention',repeat('5',64)) RETURNING id`)).rows[0]!;
    await database.query(`INSERT INTO idempotency_records(game_id,idempotency_key,request_hash,response,status,expires_at) VALUES($1,'old',repeat('a',64),NULL,'pending',now()-interval '1 hour')`, [game.id]);
    await database.query(`INSERT INTO rate_limit_buckets(bucket_key,count,reset_at) VALUES('old',1,now()-interval '1 hour')`);
    const user = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'retention-player') RETURNING id`, [game.id],
    )).rows[0]!;
    const archive = (await database.query<{ id: string }>(
      `INSERT INTO user_archives(game_id,user_id,slot,data) VALUES($1,$2,'main','{}') RETURNING id`, [game.id, user.id],
    )).rows[0]!;
    await database.query(
      `INSERT INTO archive_revisions(archive_id,game_id,user_id,slot,version,data,created_at)
       VALUES($1,$2,$3,'main',1,'{}',now()-interval '60 days')`,
      [archive.id, game.id, user.id],
    );
    const config = (await database.query<{ id: string }>(
      `INSERT INTO game_configs(game_id,config_key,value) VALUES($1,'retention','{}') RETURNING id`, [game.id],
    )).rows[0]!;
    await database.query(
      `INSERT INTO config_revisions(config_id,game_id,version,release_version,value,status,created_at)
       VALUES($1,$2,1,1,'{}','superseded',now()-interval '60 days')`,
      [config.id, game.id],
    );
    await database.query(
      `INSERT INTO game_event_definitions(game_id,event_key,name) VALUES($1,'retention_event','Retention')`, [game.id],
    );
    await database.query(
      `INSERT INTO game_events(game_id,event_key,session_id,received_at)
       VALUES($1,'retention_event','retention-session',now()-interval '60 days')`, [game.id],
    );

    const result = await runRetention(database.query, {
      auditDays: 0,
      eventDays: 30,
      archiveHistoryDays: 30,
      configHistoryDays: 30,
    });

    assert.equal(result.idempotency, 1);
    assert.equal(result.rateLimits, 1);
    assert.equal(result.events, 1);
    assert.equal(result.archiveHistory, 1);
    assert.equal(result.configHistory, 1);
  } finally {
    await database.close();
  }
});
