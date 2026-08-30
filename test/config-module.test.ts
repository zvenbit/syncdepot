import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigModule } from '../src/modules/config.js';
import { createTestDatabase } from './support/database.js';

test('较早创建的草稿后发布也会生成新的单调递增版本', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(
      `INSERT INTO admins(username,password_hash) VALUES('owner','unused') RETURNING id`,
    )).rows[0]!;
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('game','Game',repeat('a',64)) RETURNING id`,
    )).rows[0]!;
    const config = (await database.query<{ id: string }>(
      `INSERT INTO game_configs(game_id,config_key,value) VALUES($1,'global','{"release":1}') RETURNING id`,
      [game.id],
    )).rows[0]!;
    await database.query(
      `INSERT INTO config_revisions(config_id,game_id,version,value,status,note,created_by,published_at)
       VALUES($1,$2,1,'{"release":1}','published','initial',$3,now())`,
      [config.id, game.id, admin.id],
    );

    const configs = createConfigModule(database);
    const older = await configs.createDraft({ configId: config.id, value: { release: 2 }, note: 'older', adminId: admin.id });
    const newer = await configs.createDraft({ configId: config.id, value: { release: 3 }, note: 'newer', adminId: admin.id });

    const first = await configs.publishDraft({ configId: config.id, revisionId: newer.id, adminId: admin.id });
    const second = await configs.publishDraft({ configId: config.id, revisionId: older.id, adminId: admin.id });

    assert.equal(first.version, 2);
    assert.equal(second.version, 3);
    assert.deepEqual(second.value, { release: 2 });
  } finally {
    await database.close();
  }
});

test('并发创建草稿时修订号由配置锁串行分配', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('editor','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('game2','Game',repeat('b',64)) RETURNING id`)).rows[0]!;
    const config = (await database.query<{ id: string }>(`INSERT INTO game_configs(game_id,config_key,value) VALUES($1,'global','{}') RETURNING id`, [game.id])).rows[0]!;
    await database.query(`INSERT INTO config_revisions(config_id,game_id,version,value,status,note,created_by,published_at,release_version) VALUES($1,$2,1,'{}','published','initial',$3,now(),1)`, [config.id, game.id, admin.id]);
    const configs = createConfigModule(database);

    const [first, second] = await Promise.all([
      configs.createDraft({ configId: config.id, value: { n: 1 }, adminId: admin.id }),
      configs.createDraft({ configId: config.id, value: { n: 2 }, adminId: admin.id }),
    ]);

    assert.equal(first.version, 2);
    assert.equal(second.version, 3);
  } finally {
    await database.close();
  }
});

test('配置 Schema 会阻止不符合契约的发布内容', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('schema_owner','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('schema_game','Game',repeat('d',64)) RETURNING id`)).rows[0]!;
    const config = (await database.query<{ id: string }>(`INSERT INTO game_configs(game_id,config_key,value) VALUES($1,'economy','{"coins":10}') RETURNING id`, [game.id])).rows[0]!;
    await database.query(`INSERT INTO config_revisions(config_id,game_id,version,value,status,note,created_by,published_at,release_version) VALUES($1,$2,1,'{"coins":10}','published','initial',$3,now(),1)`, [config.id, game.id, admin.id]);
    const configs = createConfigModule(database);

    await configs.setSchema({
      configId: config.id,
      schema: { type: 'object', required: ['coins'], properties: { coins: { type: 'integer', minimum: 0 } }, additionalProperties: false },
      adminId: admin.id,
    });

    await assert.rejects(
      configs.publishValue({ configId: config.id, value: { coins: -1 }, adminId: admin.id }),
      /配置不符合 Schema/,
    );
    const published = await configs.publishValue({ configId: config.id, value: { coins: 20 }, adminId: admin.id });
    assert.equal(published.version, 2);
    assert.deepEqual(published.value, { coins: 20 });
  } finally {
    await database.close();
  }
});

test('存在未发布草稿时回滚仍生成独立的新发布版本', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('rollback_owner','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('rollback_game','Game',repeat('e',64)) RETURNING id`)).rows[0]!;
    const config = (await database.query<{ id: string }>(`INSERT INTO game_configs(game_id,config_key,value) VALUES($1,'global','{"n":1}') RETURNING id`, [game.id])).rows[0]!;
    await database.query(`INSERT INTO config_revisions(config_id,game_id,version,release_version,value,status,note,created_by,published_at) VALUES($1,$2,1,1,'{"n":1}','published','initial',$3,now())`, [config.id, game.id, admin.id]);
    const configs = createConfigModule(database);
    await configs.createDraft({ configId: config.id, value: { n: 99 }, adminId: admin.id });
    await configs.publishValue({ configId: config.id, value: { n: 2 }, adminId: admin.id });

    const restored = await configs.rollback({ configId: config.id, targetVersion: 1, adminId: admin.id });

    assert.equal(restored.version, 3);
    assert.deepEqual(restored.value, { n: 1 });
  } finally {
    await database.close();
  }
});

test('新建配置时立即应用 Schema 并建立发布版 v1', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('creator','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('create_game','Game',repeat('1',64)) RETURNING id`)).rows[0]!;
    const configs = createConfigModule(database);
    const created = await configs.create({
      gameId: game.id,
      configKey: 'levels',
      environment: 'production',
      value: [{ id: 1 }],
      schema: { type: 'array', items: { type: 'object', required: ['id'] } },
      adminId: admin.id,
    });
    assert.equal(created.version, 1);
    assert.deepEqual(created.schema, { type: 'array', items: { type: 'object', required: ['id'] } });
  } finally {
    await database.close();
  }
});

test('批量导入在已有草稿时仍使用独立的发布版本', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('importer','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('import_game','Game',repeat('6',64)) RETURNING id`)).rows[0]!;
    const configs = createConfigModule(database);
    const created = await configs.create({ gameId: game.id, configKey: 'items', environment: 'production', value: [], adminId: admin.id });
    await configs.createDraft({ configId: created.id, value: [{ id: 99 }], adminId: admin.id });

    const result = await configs.importMany({
      gameId: game.id,
      items: [{ configKey: 'items', environment: 'production', value: [{ id: 1 }], description: 'imported' }],
      adminId: admin.id,
    });

    assert.equal(result.imported, 1);
    const current = (await database.query<{ version: number; value: unknown }>('SELECT version,value FROM game_configs WHERE id=$1', [created.id])).rows[0]!;
    assert.equal(current.version, 2);
    assert.deepEqual(current.value, [{ id: 1 }]);
  } finally {
    await database.close();
  }
});

test('删除配置与审计记录在同一事务完成', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('deleter','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('delete_game','Game',repeat('7',64)) RETURNING id`)).rows[0]!;
    const configs = createConfigModule(database);
    const created = await configs.create({ gameId: game.id, configKey: 'old', environment: 'production', value: {}, adminId: admin.id });

    await configs.remove({ configId: created.id, adminId: admin.id });

    assert.equal((await database.query('SELECT 1 FROM game_configs WHERE id=$1', [created.id])).rowCount, 0);
    assert.equal((await database.query(`SELECT 1 FROM audit_logs WHERE resource_id=$1 AND action='config.delete'`, [created.id])).rowCount, 1);
  } finally {
    await database.close();
  }
});

test('配置草稿可以定时发布并保持线上版本单调递增', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(
      `INSERT INTO admins(username,password_hash) VALUES('scheduler','unused') RETURNING id`,
    )).rows[0]!;
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('schedule_game','Game',repeat('8',64)) RETURNING id`,
    )).rows[0]!;
    const configs = createConfigModule(database);
    const config = await configs.create({
      gameId: game.id,
      configKey: 'global',
      environment: 'production',
      value: { version: 1 },
      adminId: admin.id,
    });
    const draft = await configs.createDraft({ configId: config.id, value: { version: 2 }, adminId: admin.id });
    const publishAt = new Date(Date.now() + 60_000);
    const scheduled = await configs.scheduleDraft({
      configId: config.id,
      revisionId: draft.id,
      publishAt,
      adminId: admin.id,
    });
    assert.equal(new Date(scheduled.scheduled_at!).toISOString(), publishAt.toISOString());

    assert.deepEqual(await configs.publishScheduled(new Date(publishAt.getTime() - 1)), { published: 0 });
    assert.deepEqual(await configs.publishScheduled(new Date(publishAt.getTime() + 1)), { published: 1 });
    const current = (await database.query<{ version: number; value: unknown }>(
      'SELECT version,value FROM game_configs WHERE id=$1', [config.id],
    )).rows[0]!;
    assert.equal(current.version, 2);
    assert.deepEqual(current.value, { version: 2 });
  } finally {
    await database.close();
  }
});

test('多个配置草稿在同一事务中批量发布', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(
      `INSERT INTO admins(username,password_hash) VALUES('batch-publisher','unused') RETURNING id`,
    )).rows[0]!;
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('batch_publish','Game',repeat('9',64)) RETURNING id`,
    )).rows[0]!;
    const configs = createConfigModule(database);
    const first = await configs.create({ gameId: game.id, configKey: 'first', environment: 'production', value: { n: 1 }, adminId: admin.id });
    const second = await configs.create({ gameId: game.id, configKey: 'second', environment: 'production', value: { n: 1 }, adminId: admin.id });
    const firstDraft = await configs.createDraft({ configId: first.id, value: { n: 2 }, adminId: admin.id });
    const secondDraft = await configs.createDraft({ configId: second.id, value: { n: 2 }, adminId: admin.id });

    const result = await configs.publishBatch({
      gameId: game.id,
      items: [
        { configId: first.id, revisionId: firstDraft.id },
        { configId: second.id, revisionId: secondDraft.id },
      ],
      adminId: admin.id,
    });
    assert.equal(result.published.length, 2);
    const current = (await database.query<{ config_key: string; version: number; value: unknown }>(
      `SELECT config_key,version,value FROM game_configs WHERE game_id=$1 ORDER BY config_key`, [game.id],
    )).rows;
    assert.deepEqual(current, [
      { config_key: 'first', version: 2, value: { n: 2 } },
      { config_key: 'second', version: 2, value: { n: 2 } },
    ]);
  } finally {
    await database.close();
  }
});
