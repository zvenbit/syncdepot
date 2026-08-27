import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, newApiKey, requiredString, sha256, signToken, verifyPassword, verifyToken } from '../src/lib.js';

test('密码使用随机盐并能验证', () => {
  const a = hashPassword('a-secure-password');
  const b = hashPassword('a-secure-password');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('a-secure-password', a), true);
  assert.equal(verifyPassword('wrong-password', a), false);
});

test('JWT 可验证且篡改后失效', () => {
  const token = signToken({ sub: 'admin-1' }, 'test-secret', 60);
  assert.equal(verifyToken(token, 'test-secret')?.sub, 'admin-1');
  assert.equal(verifyToken(token + 'x', 'test-secret'), null);
  assert.equal(verifyToken(token, 'other-secret'), null);
});

test('API Key 随机生成且只存摘要', () => {
  const key = newApiKey();
  assert.match(key, /^gk_/);
  assert.equal(sha256(key).length, 64);
});

test('必填字符串校验并去除首尾空白', () => {
  assert.equal(requiredString('  hello  ', 'name'), 'hello');
  assert.throws(() => requiredString('', 'name'), /name/);
});
