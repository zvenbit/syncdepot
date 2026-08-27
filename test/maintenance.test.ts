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

    const result = await runRetention(database.query, { auditDays: 0 });

    assert.equal(result.idempotency, 1);
    assert.equal(result.rateLimits, 1);
  } finally {
    await database.close();
  }
});
