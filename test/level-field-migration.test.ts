import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

test('012 将旧版关卡字段升级为字段和描述对象', async () => {
  const database = await PGlite.create();
  try {
    for (const name of [
      '001_init.sql',
      '002_production_features.sql',
      '003_sync_core_upgrade.sql',
      '004_operational_analytics.sql',
      '005_project_defined_events.sql',
      '006_game_platform_credentials.sql',
      '007_admin_password_security.sql',
      '008_level_progress_analytics.sql',
    ]) {
      await database.exec(await fs.readFile(path.resolve('migrations', name), 'utf8'));
    }
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash)
       VALUES('migration_level_fields','Migration Fields',repeat('a',64)) RETURNING id`,
    )).rows[0]!;
    await database.query(
      `INSERT INTO game_event_definitions(game_id,event_key,name,analysis_type,settings)
       VALUES($1,'level_progress','关卡进度','level_progress',$2::jsonb)`,
      [game.id, JSON.stringify({
        level_fields: [
          'classic_level',
          { field: 'challenge_level', description: '挑战玩法' },
        ],
      })],
    );

    await database.exec(await fs.readFile(path.resolve('migrations/012_level_field_descriptions.sql'), 'utf8'));

    const row = (await database.query<{ settings: unknown }>(
      `SELECT settings FROM game_event_definitions WHERE game_id=$1`, [game.id],
    )).rows[0]!;
    assert.deepEqual(row.settings, {
      level_fields: [
        { field: 'classic_level', description: 'classic_level' },
        { field: 'challenge_level', description: '挑战玩法' },
      ],
    });
  } finally {
    await database.close();
  }
});
