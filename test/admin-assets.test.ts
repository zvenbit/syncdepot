import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdminAssetModule } from '../src/modules/admin-assets.js';

test('后台资源开发时读取最新文件，生产缓存已加载内容', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncdepot-admin-assets-'));
  const htmlPath = path.join(root, 'index.html');
  await fs.writeFile(htmlPath, 'version-1');
  const development = createAdminAssetModule({ root, cache: false });
  const production = createAdminAssetModule({ root, cache: true });

  assert.equal((await development.read('html')).body, 'version-1');
  assert.equal((await production.read('html')).body, 'version-1');
  await fs.writeFile(htmlPath, 'version-2');

  assert.equal((await development.read('html')).body, 'version-2');
  assert.equal((await production.read('html')).body, 'version-1');
});
