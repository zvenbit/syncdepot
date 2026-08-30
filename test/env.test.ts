import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeConfig, validateProductionConfig } from '../src/env.js';

test('运行配置拒绝无效数值和不完整的管理员初始化账号', () => {
  assert.throws(() => readRuntimeConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => readRuntimeConfig({ ADMIN_USERNAME: 'admin' }), /必须同时设置/);
  assert.throws(() => readRuntimeConfig({ TRUST_PROXY: 'yes' }), /true 或 false/);
  assert.throws(() => readRuntimeConfig({ CLIENT_CORS_ORIGINS: '*' }), /不能使用/);
  assert.deepEqual(readRuntimeConfig({
    CLIENT_CORS_ORIGINS: 'http://localhost:7456/, https://preview.example.com',
  }).clientCorsOrigins, [
    'http://localhost:7456',
    'https://preview.example.com',
  ]);
});

test('生产环境拒绝示例密钥并接受独立随机密钥', () => {
  const placeholder = readRuntimeConfig({ NODE_ENV: 'production', JWT_SECRET: 'development-only-secret-change-me' });
  assert.throws(() => validateProductionConfig(placeholder), /示例值/);
  const valid = readRuntimeConfig({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-only-jwt-secret-not-for-production-000000000001',
    CREDENTIAL_ENCRYPTION_KEY: 'test-only-credential-key-not-for-production-000001',
  });
  assert.doesNotThrow(() => validateProductionConfig(valid));
});
