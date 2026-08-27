import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseRateLimitStore } from '../src/rate-limit.js';
import { createTestDatabase } from './support/database.js';

test('数据库限流适配器在多个实例之间共享计数', async () => {
  const database = await createTestDatabase();
  try {
    const firstInstance = createDatabaseRateLimitStore(database.query);
    const secondInstance = createDatabaseRateLimitStore(database.query);
    const now = Date.now();
    assert.equal((await firstInstance.consume('route:user', 2, 60_000, now)).allowed, true);
    assert.equal((await secondInstance.consume('route:user', 2, 60_000, now)).allowed, true);
    const blocked = await firstInstance.consume('route:user', 2, 60_000, now);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
  } finally {
    await database.close();
  }
});
