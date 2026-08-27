import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRowCount } from '../src/result.js';

test('PGlite SELECT 有返回行时不被 affectedRows=0 覆盖', () => {
  assert.equal(resolveRowCount(1, 0), 1);
  assert.equal(resolveRowCount(3, 0), 3);
});

test('无返回行的写操作使用 affectedRows', () => {
  assert.equal(resolveRowCount(0, 2), 2);
  assert.equal(resolveRowCount(0), 0);
});
