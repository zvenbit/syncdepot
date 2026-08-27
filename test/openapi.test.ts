import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { openApiDocument } from '../src/openapi.js';

test('OpenAPI 覆盖所有公开数据和管理接口', async () => {
  const source = await fs.readFile('src/server.ts', 'utf8');
  const ignored = new Set(['/', '/admin', '/openapi.json', '/sdk/game-client.ts']);
  const registered = [...source.matchAll(/app\.(?:get|post|put|patch|delete)\('([^']+)'/g)]
    .map(match => match[1]!.replace(/:([A-Za-z]+)/g, '{$1}'))
    .filter(route => !ignored.has(route));
  const documented = new Set(Object.keys(openApiDocument.paths));
  assert.deepEqual([...new Set(registered)].filter(route => !documented.has(route)), []);
});
