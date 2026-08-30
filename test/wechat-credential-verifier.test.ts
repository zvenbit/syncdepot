import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatCredentialVerifier } from '../src/adapters/wechat-credential-verifier.js';

test('微信登录 code 成功换取 OpenID', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => Response.json({
      openid: 'openid-100',
      session_key: 'must-not-leak',
    }),
  });

  const identity = await verifier.verify({
    gameKey: 'test_project',
    provider: 'wechat',
    credential: 'wx-login-code',
  });

  assert.deepEqual(identity, { subject: 'openid-100' });
});

test('微信 UnionID 映射为外部用户标识', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => Response.json({
      openid: 'openid-100',
      unionid: 'unionid-200',
      session_key: 'must-not-leak',
    }),
  });

  const identity = await verifier.verify({
    gameKey: 'test_project',
    provider: 'wechat',
    credential: 'wx-login-code',
  });

  assert.deepEqual(identity, {
    subject: 'openid-100',
    externalUserId: 'unionid-200',
  });
});

test('微信 Adapter 拒绝其他平台凭证', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => {
      throw new Error('不应访问微信网络');
    },
  });

  await assert.rejects(
    verifier.verify({ gameKey: 'game', provider: 'bytedance', credential: 'code' }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, '不支持的平台身份类型');
      return true;
    },
  );
});

test('微信无效或已使用 code 返回稳定的 401', async () => {
  for (const errcode of [40029, 40163]) {
    const verifier = createWechatCredentialVerifier({
      appId: 'wx-app-id',
      appSecret: 'wechat-app-secret',
      fetch: async () => Response.json({ errcode, errmsg: 'sensitive upstream detail' }),
    });

    await assert.rejects(
      verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'invalid-code' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 401);
        assert.equal(error.message, '微信登录凭证无效，请重新登录');
        return true;
      },
    );
  }
});

test('微信频率限制返回 429', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => Response.json({ errcode: 45011, errmsg: 'rate limit' }),
  });

  await assert.rejects(
    verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.message, '微信登录请求过于频繁，请稍后重试');
      return true;
    },
  );
});

test('微信系统繁忙返回 503', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => Response.json({ errcode: -1, errmsg: 'system busy' }),
  });

  await assert.rejects(
    verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.message, '微信登录暂时不可用');
      return true;
    },
  );
});

test('微信应用凭证配置错误返回 503', async () => {
  for (const errcode of [40013, 40125, 40164, 41002, 41004]) {
    const verifier = createWechatCredentialVerifier({
      appId: 'wx-app-id',
      appSecret: 'wechat-app-secret',
      fetch: async () => Response.json({ errcode, errmsg: 'configuration detail' }),
    });

    await assert.rejects(
      verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, '微信登录配置不可用');
        return true;
      },
    );
  }
});

test('其他微信错误返回稳定的 502', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => Response.json({ errcode: 49999, errmsg: 'unknown sensitive detail' }),
  });

  await assert.rejects(
    verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message, '微信登录验证失败');
      return true;
    },
  );
});

test('微信成功响应缺少 OpenID 时返回 502', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => Response.json({ session_key: 'must-not-leak' }),
  });

  await assert.rejects(
    verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message, '微信登录响应无效');
      return true;
    },
  );
});

test('微信网络异常与超时返回脱敏的 503', async () => {
  const upstreamErrors = [
    new Error('network failed: wechat-app-secret wx-login-code session-key-value'),
    new DOMException('wx-login-code timed out', 'TimeoutError'),
  ];
  for (const upstreamError of upstreamErrors) {
    const verifier = createWechatCredentialVerifier({
      appId: 'wx-app-id',
      appSecret: 'wechat-app-secret',
      fetch: async () => { throw upstreamError; },
    });

    await assert.rejects(
      verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'wx-login-code' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 503);
        assert.equal(error.message, '微信登录暂时不可用');
        assert.doesNotMatch(String(error), /wechat-app-secret|wx-login-code|session-key-value/);
        return true;
      },
    );
  }
});

test('微信 HTTP 失败不会作为成功身份处理', async () => {
  const cases = [
    { upstreamStatus: 429, statusCode: 429, message: '微信登录请求过于频繁，请稍后重试' },
    { upstreamStatus: 500, statusCode: 503, message: '微信登录暂时不可用' },
    { upstreamStatus: 400, statusCode: 502, message: '微信登录验证失败' },
  ];
  for (const item of cases) {
    const verifier = createWechatCredentialVerifier({
      appId: 'wx-app-id',
      appSecret: 'wechat-app-secret',
      fetch: async () => Response.json({}, { status: item.upstreamStatus }),
    });

    await assert.rejects(
      verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, item.statusCode);
        assert.equal(error.message, item.message);
        return true;
      },
    );
  }
});

test('微信非 JSON 响应返回 502', async () => {
  const verifier = createWechatCredentialVerifier({
    appId: 'wx-app-id',
    appSecret: 'wechat-app-secret',
    fetch: async () => new Response('gateway html', { status: 200 }),
  });

  await assert.rejects(
    verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
    (error: Error & { statusCode?: number }) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message, '微信登录响应无效');
      return true;
    },
  );
});

test('微信非对象 JSON 响应返回 502', async () => {
  for (const payload of [null, [], 'unexpected']) {
    const verifier = createWechatCredentialVerifier({
      appId: 'wx-app-id',
      appSecret: 'wechat-app-secret',
      fetch: async () => Response.json(payload),
    });

    await assert.rejects(
      verifier.verify({ gameKey: 'game', provider: 'wechat', credential: 'code' }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.message, '微信登录响应无效');
        return true;
      },
    );
  }
});
