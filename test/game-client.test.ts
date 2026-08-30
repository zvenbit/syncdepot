import test from 'node:test';
import assert from 'node:assert/strict';
import { GameDataClient } from '../sdk/game-client.js';

test('SDK 使用项目测试账号换取并保存玩家 Token', async () => {
  let requests = 0;
  const client = new GameDataClient({
    baseUrl: 'https://game.example',
    gameId: 'local-test-game',
    fetch: async (input, init) => {
      requests += 1;
      if (requests === 1) {
        assert.equal(String(input), 'https://game.example/api/client/test-session');
        assert.equal((init?.headers as Record<string, string>)['X-Game-Id'], 'local-test-game');
        assert.deepEqual(JSON.parse(String(init?.body)), { username: 'local_tester', password: 'test-password' });
        return Response.json({ user_token: 'test-user-token' });
      }
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-user-token');
      return Response.json({ configs: {} });
    },
  });

  const token = await client.startTestSession('local_tester', 'test-password');
  await client.getUserConfigs();

  assert.equal(token, 'test-user-token');
  assert.equal(requests, 2);
});

test('SDK 使用用户 Token 读取全部玩家配置', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://game.example/api/client/me/configs?environment=production');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer user-token');
      assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], undefined);
      return Response.json({
        configs: {
          feature_flags: {
            value: { new_feature: true },
            version: 3,
            updated_at: '2026-08-28T00:00:00.000Z',
          },
        },
      });
    };
    const client = new GameDataClient({ baseUrl: 'https://game.example', gameId: 'test_project' });
    client.setUserToken('user-token');

    const configs = await client.getUserConfigs();

    assert.deepEqual(configs.feature_flags, {
      value: { new_feature: true },
      version: 3,
      updated_at: '2026-08-28T00:00:00.000Z',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SDK 使用用户 Token 读取单项玩家配置', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://game.example/api/client/me/configs/feature%20flags?environment=staging');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer user-token');
      return Response.json({
        config_key: 'feature flags',
        value: { preview: true },
        version: 4,
        updated_at: '2026-08-28T01:00:00.000Z',
      });
    };
    const client = new GameDataClient({ baseUrl: 'https://game.example', gameId: 'test_project' });
    client.setUserToken('user-token');

    const config = await client.getUserConfig<{ preview: boolean }>('feature flags', 'staging');

    assert.deepEqual(config, {
      config_key: 'feature flags',
      value: { preview: true },
      version: 4,
      updated_at: '2026-08-28T01:00:00.000Z',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SDK 使用 ETag 缓存并在断网时回退到最近配置', async () => {
  const cache = new Map<string, string>();
  let requests = 0;
  let lastIfNoneMatch: string | undefined;
  const client = new GameDataClient({
    baseUrl: 'https://game.example',
    gameId: 'cached-game',
    configCache: {
      getItem: key => cache.get(key) || null,
      setItem: (key, value) => { cache.set(key, value); },
    },
    fetch: async (_input, init) => {
      requests += 1;
      lastIfNoneMatch = (init?.headers as Record<string, string>)['If-None-Match'];
      if (requests === 1) {
        return Response.json(
          { configs: { global: { value: { enabled: true }, version: 2, updated_at: '2026-08-29T00:00:00.000Z' } } },
          { headers: { ETag: '"config-v2"' } },
        );
      }
      if (requests === 2) return new Response(null, { status: 304 });
      throw new Error('offline');
    },
  });
  client.setUserToken('cached-user-token');

  const first = await client.getUserConfigs();
  const notModified = await client.getUserConfigs();
  const offline = await client.getUserConfigs();

  assert.deepEqual(notModified, first);
  assert.deepEqual(offline, first);
  assert.equal(lastIfNoneMatch, '"config-v2"');
});

test('SDK 缓存写入失败时仍返回刚取得的新配置', async () => {
  const stale = {
    configs: { global: { value: { enabled: false }, version: 1, updated_at: '2026-08-28T00:00:00.000Z' } },
  };
  const fresh = {
    configs: { global: { value: { enabled: true }, version: 2, updated_at: '2026-08-29T00:00:00.000Z' } },
  };
  const client = new GameDataClient({
    baseUrl: 'https://game.example',
    gameId: 'cache-write-failure',
    configCache: {
      getItem: () => JSON.stringify({ etag: '"stale"', value: stale }),
      setItem: () => { throw new Error('storage quota exceeded'); },
    },
    fetch: async () => Response.json(fresh, { headers: { ETag: '"fresh"' } }),
  });
  client.setUserToken('cache-user-token');

  const configs = await client.getUserConfigs();

  assert.deepEqual(configs, fresh.configs);
});

test('SDK 为关卡结果自动补充发生时间和幂等键并返回逐条结果', async () => {
  const client = new GameDataClient({
    baseUrl: 'https://game.example',
    gameId: 'level-result-game',
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://game.example/api/client/me/events');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer player-token');
      const payload = JSON.parse(String(init?.body)) as {
        events: Array<Record<string, unknown>>;
      };
      assert.equal(payload.events.length, 1);
      assert.deepEqual(payload.events[0]!.properties, {
        schema_version: 1,
        mode_id: 'custom_mode',
        level_id: 'custom-001',
        level_order: 1,
        result: 'success',
      });
      assert.equal(Number.isNaN(Date.parse(String(payload.events[0]!.occurred_at))), false);
      assert.equal(typeof payload.events[0]!.idempotency_key, 'string');
      assert.notEqual(payload.events[0]!.idempotency_key, '');
      return Response.json({
        accepted: 1,
        duplicated: 0,
        rejected: 0,
        results: [{ index: 0, eventKey: 'level_result', status: 'accepted' }],
      });
    },
  });
  client.setUserToken('player-token');

  const result = await client.trackEvent('level_result', {
    schema_version: 1,
    mode_id: 'custom_mode',
    level_id: 'custom-001',
    level_order: 1,
    result: 'success',
  });

  assert.equal(result.accepted, 1);
  assert.equal(result.results[0]!.status, 'accepted');
});

test('SDK 将不存在的玩家存档作为 null 返回并支持删除存档', async () => {
  let requests = 0;
  const client = new GameDataClient({
    baseUrl: 'https://game.example',
    gameId: 'archive-game',
    fetch: async (input, init) => {
      requests += 1;
      assert.equal(String(input), 'https://game.example/api/client/me/archives/local%20slot');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer archive-token');
      if (requests === 1) return Response.json(null);
      assert.equal(init?.method, 'DELETE');
      return Response.json({ deleted: true });
    },
  });
  client.setUserToken('archive-token');

  const missing = await client.loadArchive('local slot');
  const deleted = await client.deleteArchive('local slot');

  assert.equal(missing, null);
  assert.deepEqual(deleted, { deleted: true });
});
