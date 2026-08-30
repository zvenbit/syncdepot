import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runMigrations, type MigrationPool } from '../src/migration-runner.js';

const publishedTestAccountsChecksum = 'f57fdd650d6aa710725dc92ee3f67308ad4484af5d2a56539187e9fa1e9140ff';

test('已执行 010 的数据库通过新增迁移升级，不修改历史迁移', async () => {
  const directory = path.resolve('migrations');
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const applied = new Map<string, string>();

  for (const name of names.filter(name => name < '011_')) {
    const sql = await fs.readFile(path.join(directory, name), 'utf8');
    const checksum = name === '010_game_test_accounts.sql'
      ? publishedTestAccountsChecksum
      : crypto.createHash('sha256').update(sql).digest('hex');
    applied.set(name, checksum);
  }

  const pool = {
    async connect() {
      return {
        async query(text: string, params: unknown[] = []) {
          if (text.startsWith('SELECT checksum FROM schema_migrations')) {
            const checksum = applied.get(String(params[0]));
            return { rows: checksum ? [{ checksum }] : [], rowCount: checksum ? 1 : 0 };
          }
          if (text.startsWith('INSERT INTO schema_migrations')) {
            applied.set(String(params[0]), String(params[1]));
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  } as unknown as MigrationPool;

  await runMigrations({ pool, databaseMode: 'pglite', directory });

  assert.equal(applied.get('010_game_test_accounts.sql'), publishedTestAccountsChecksum);
  assert.ok(applied.has('011_game_events_user_index.sql'));
  assert.ok(applied.has('012_level_field_descriptions.sql'));
  assert.ok(applied.has('013_level_result_analytics.sql'));
  assert.ok(applied.has('014_project_types.sql'));
});
