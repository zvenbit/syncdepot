import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { openApiDocument } from '../src/openapi.js';
import { httpContracts } from '../src/http-contracts.js';

test('OpenAPI 覆盖所有公开数据和管理接口', async () => {
  const source = await fs.readFile('src/server.ts', 'utf8');
  const registered = [...source.matchAll(/app\.(?:get|post|put|patch|delete)\('([^']+)'/g)]
    .map(match => match[1]!.replace(/:([A-Za-z]+)/g, '{$1}'))
    .filter(route => route === '/health' || route.startsWith('/api/'));
  const documented = new Set(Object.keys(openApiDocument.paths));
  assert.deepEqual([...new Set(registered)].filter(route => !documented.has(route)), []);
});

test('OpenAPI 复用请求契约并描述客户端关键响应', () => {
  const document = openApiDocument as unknown as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
    components: { schemas: Record<string, unknown> };
  };
  const createAdmin = document.paths['/api/admin/admins']!.post! as {
    requestBody: { content: { 'application/json': { schema: unknown } } };
  };
  assert.deepEqual(createAdmin.requestBody.content['application/json'].schema, httpContracts.adminCreate.body);

  const testSession = document.paths['/api/client/test-session']!.post! as {
    parameters: Array<{ name: string; in: string; required: boolean }>;
  };
  assert.deepEqual(testSession.parameters.find(item => item.name === 'X-Game-Id'), {
    name: 'X-Game-Id', in: 'header', required: true, schema: { type: 'string' },
  });

  const archiveRead = document.paths['/api/client/me/archives/{slot}']!.get! as {
    responses: Record<string, { content: { 'application/json': { schema: unknown } } }>;
  };
  assert.deepEqual(archiveRead.responses['200']!.content['application/json'].schema, {
    anyOf: [{ $ref: '#/components/schemas/Archive' }, { type: 'null' }],
  });

  const levelResult = document.paths['/api/admin/games/{id}/analytics/level-results']!.get! as {
    parameters: Array<{ name: string; required: boolean }>;
  };
  assert.equal(levelResult.parameters.find(item => item.name === 'event_key')?.required, true);
  assert.equal(levelResult.parameters.find(item => item.name === 'mode_id')?.required, true);
  const propertyAnalysis = document.paths['/api/admin/games/{id}/analytics/properties']!.get! as {
    parameters: Array<{ name: string; required: boolean }>;
  };
  assert.equal(propertyAnalysis.parameters.find(item => item.name === 'event_key')?.required, true);

  const events = document.paths['/api/client/events']!.post! as {
    requestBody: { content: { 'application/json': { schema: unknown } } };
  };
  assert.deepEqual(events.requestBody.content['application/json'].schema, httpContracts.events.body);
  assert.ok(document.components.schemas.TrackingResult);
});
