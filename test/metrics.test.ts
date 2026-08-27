import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsCollector } from '../src/metrics.js';
import { createTestDatabase } from './support/database.js';

test('请求指标先进入内存队列并批量聚合写入数据库', async () => {
  const database = await createTestDatabase();
  try {
    const game = (await database.query<{ id: string }>(`INSERT INTO games(game_key,name,api_key_hash) VALUES('metrics_game','Metrics',repeat('4',64)) RETURNING id`)).rows[0]!;
    const metrics = createMetricsCollector({ query: database.query, autoStart: false });
    metrics.record({ gameId: game.id, route: '/configs', statusCode: 200, durationMs: 10 });
    metrics.record({ gameId: game.id, route: '/configs', statusCode: 500, durationMs: 30 });
    assert.equal((await database.query(`SELECT * FROM api_metrics_daily WHERE game_id=$1`, [game.id])).rowCount, 0);

    await metrics.flush();

    const row = (await database.query<{ requests: number; errors: number; total_duration_ms: number }>(`SELECT requests,errors,total_duration_ms FROM api_metrics_daily WHERE game_id=$1`, [game.id])).rows[0]!;
    assert.equal(Number(row.requests), 2);
    assert.equal(Number(row.errors), 1);
    assert.equal(Number(row.total_duration_ms), 40);
  } finally {
    await database.close();
  }
});
