import type { DatabaseClient } from '../db.js';

export type GameAccessDatabase = { query: DatabaseClient['query'] };
export type MembershipRole = 'viewer' | 'editor' | 'owner';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export function createGameAccessModule(database: GameAccessDatabase) {
  return {
    async assert(command: {
      adminId: string;
      globalRole: 'admin' | 'viewer';
      gameId: string;
      permission: 'read' | 'write' | 'owner';
    }): Promise<void> {
      if (command.globalRole === 'admin') return;
      const membership = (await database.query<{ role: MembershipRole }>(
        'SELECT role FROM game_memberships WHERE game_id=$1 AND admin_id=$2',
        [command.gameId, command.adminId],
      )).rows[0];
      if (!membership) throw fail(403, '没有该游戏的访问权限');
      if (command.permission === 'write' && membership.role === 'viewer') throw fail(403, '没有该游戏的写入权限');
      if (command.permission === 'owner' && membership.role !== 'owner') throw fail(403, '只有游戏所有者可以执行该操作');
    },

    async visibleGameIds(adminId: string, globalRole: 'admin' | 'viewer'): Promise<string[] | null> {
      if (globalRole === 'admin') return null;
      return (await database.query<{ game_id: string }>(
        'SELECT game_id FROM game_memberships WHERE admin_id=$1 ORDER BY created_at', [adminId],
      )).rows.map(row => row.game_id);
    },
  };
}
