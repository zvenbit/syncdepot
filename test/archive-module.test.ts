import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveSyncModule } from '../src/modules/archive.js';
import { createTestDatabase } from './support/database.js';

test('相同幂等键的存档重试返回第一次结果而不增加版本', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(
      `INSERT INTO games(game_key,name,api_key_hash) VALUES('archive_game','Archive',repeat('c',64)) RETURNING id`,
    )).rows[0]!;
    const user = (await database.query<{ id: string }>(
      `INSERT INTO game_users(game_id,external_user_id) VALUES($1,'player') RETURNING id`, [game.id],
    )).rows[0]!;
    const archives = createArchiveSyncModule(database, { maxBytes: 1024 });
    const command = {
      gameId: game.id,
      userId: user.id,
      slot: 'main',
      data: { level: 7 },
      idempotencyKey: 'save-1',
      actor: { actorType: 'user' as const, actorId: user.id },
    };

    const results = await Promise.all([archives.save(command), archives.save(command)]);
    const saved = results.find(result => result.kind === 'saved')!;
    const replayed = results.find(result => result.kind === 'replayed')!;

    assert.equal(saved.kind, 'saved');
    assert.equal(replayed.kind, 'replayed');
    assert.equal(replayed.archive.version, 1);
    assert.equal(replayed.archive.id, saved.archive.id);
  } finally {
    await database.close();
  }
});

test('恢复历史存档会生成新版本而不改写历史', async () => {
  const database = await createTestDatabase();
  try {
    const admin = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash) VALUES('archive_admin','unused') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('restore_game','Archive',repeat('2',64)) RETURNING id`)).rows[0]!;
    const user = (await database.query<{ id: string }>(`INSERT INTO game_users(game_id,external_user_id) VALUES($1,'player') RETURNING id`, [game.id])).rows[0]!;
    const archives = createArchiveSyncModule(database, { maxBytes: 1024 });
    const first = await archives.save({ gameId: game.id, userId: user.id, slot: 'main', data: { level: 1 }, actor: { actorType: 'user', actorId: user.id } });
    await archives.save({ gameId: game.id, userId: user.id, slot: 'main', data: { level: 2 }, version: 1, actor: { actorType: 'user', actorId: user.id } });

    const restored = await archives.restore({
      archiveId: first.archive.id,
      targetVersion: 1,
      actor: { actorType: 'admin', actorId: admin.id, adminId: admin.id },
    });

    assert.equal(restored.version, 3);
    assert.deepEqual(restored.data, { level: 1 });
  } finally {
    await database.close();
  }
});
