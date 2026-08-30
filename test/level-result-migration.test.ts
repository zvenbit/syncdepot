import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

test('013 将旧最高进度定义直接迁移为关卡结果定义且不伪造历史结果', async () => {
  const database = await PGlite.create();
  try {
    const names = (await fs.readdir(path.resolve('migrations')))
      .filter(name => name.endsWith('.sql') && name < '013_')
      .sort();
    for (const name of names) await database.exec(await fs.readFile(path.resolve('migrations', name), 'utf8'));

    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash)
       VALUES('migrate_level_result','Migrate Result',repeat('b',64)) RETURNING id`,
    )).rows[0]!;
    const player = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'player') RETURNING id`, [game.id],
    )).rows[0]!;
    await database.query(
      `INSERT INTO game_event_definitions(game_id,event_key,name,analysis_type,settings)
       VALUES($1,'legacy_progress','旧进度','level_progress',$2::jsonb)`,
      [game.id, JSON.stringify({
        level_fields: [
          { field: 'main_level', description: '主线' },
          { field: 'challenge_level', description: '挑战' },
        ],
      })],
    );
    await database.query(
      `INSERT INTO game_events(game_id,event_key,user_id,properties,idempotency_key)
       VALUES($1,'legacy_progress',$2,$3::jsonb,'legacy-progress-1')`,
      [game.id, player.id, JSON.stringify({ main_level: 8 })],
    );

    await database.exec(await fs.readFile(path.resolve('migrations/013_level_result_analytics.sql'), 'utf8'));

    const definition = (await database.query<{ analysis_type: string; settings: Record<string, unknown> }>(
      `SELECT analysis_type,settings FROM game_event_definitions WHERE game_id=$1`, [game.id],
    )).rows[0]!;
    assert.equal(definition.analysis_type, 'level_result');
    assert.deepEqual(definition.settings.modes, [
      { id: 'main_level', display_name: '主线', fail_reasons: [] },
      { id: 'challenge_level', display_name: '挑战', fail_reasons: [] },
    ]);
    assert.equal(definition.settings.suspected_stuck_failures, 3);
    assert.equal(typeof definition.settings.collection_started_at, 'string');
    assert.equal((await database.query(`SELECT * FROM level_result_events`)).rows.length, 0);
    assert.equal((await database.query(`SELECT * FROM game_events WHERE game_id=$1`, [game.id])).rows.length, 1);
  } finally {
    await database.close();
  }
});
