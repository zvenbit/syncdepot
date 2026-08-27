import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameAccessModule } from '../src/modules/game-access.js';
import { createTestDatabase } from './support/database.js';

test('游戏成员只能执行其角色允许的操作', async () => {
  const database = await createTestDatabase();
  try {
    const viewer = (await database.query<{ id: string }>(`INSERT INTO admins(username,password_hash,role) VALUES('member','unused','viewer') RETURNING id`)).rows[0]!;
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('rbac_game','Game',repeat('3',64)) RETURNING id`)).rows[0]!;
    await database.query(`INSERT INTO game_memberships(game_id,admin_id,role) VALUES($1,$2,'viewer')`, [game.id, viewer.id]);
    const access = createGameAccessModule(database);

    await access.assert({ adminId: viewer.id, globalRole: 'viewer', gameId: game.id, permission: 'read' });
    await assert.rejects(
      access.assert({ adminId: viewer.id, globalRole: 'viewer', gameId: game.id, permission: 'write' }),
      /没有该游戏的写入权限/,
    );
    await database.query(`UPDATE game_memberships SET role='editor' WHERE game_id=$1 AND admin_id=$2`, [game.id, viewer.id]);
    await access.assert({ adminId: viewer.id, globalRole: 'viewer', gameId: game.id, permission: 'write' });
    await assert.rejects(
      access.assert({ adminId: viewer.id, globalRole: 'viewer', gameId: game.id, permission: 'owner' }),
      /只有游戏所有者/,
    );
  } finally {
    await database.close();
  }
});
