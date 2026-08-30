import test from 'node:test';
import assert from 'node:assert/strict';
import { deepJsonDiff } from '../src/modules/json-diff.js';

test('配置差异递归定位嵌套对象和数组字段', () => {
  const result = deepJsonDiff(
    { shop: { enabled: false, items: [{ price: 10 }, { id: 2 }] } },
    { shop: { enabled: true, items: [{ price: 12 }], title: '商城' } },
  );
  assert.deepEqual(result, {
    changes: [
      { path: '/shop/enabled', kind: 'changed', before: false, after: true },
      { path: '/shop/items/0/price', kind: 'changed', before: 10, after: 12 },
      { path: '/shop/items/1', kind: 'removed', before: { id: 2 } },
      { path: '/shop/title', kind: 'added', after: '商城' },
    ],
    truncated: false,
  });
});
