import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';

test('迁移器可将重新打开的持久 PGlite 从 003 升级到最新版本', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'syncdepot-persistent-migrate-'));
  try {
    const initial = await PGlite.create(dataDir);
    for (const name of ['001_init.sql', '002_production_features.sql', '003_sync_core_upgrade.sql']) {
      await initial.exec(await fs.readFile(path.resolve('migrations', name), 'utf8'));
    }
    await initial.exec(`
      CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum char(64)
      );
      INSERT INTO schema_migrations(name) VALUES
        ('001_init.sql'),('002_production_features.sql'),('003_sync_core_upgrade.sql');
    `);
    await initial.close();

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/migrate.ts'], {
      cwd: path.resolve('.'),
      env: { ...process.env, DATABASE_URL: '', PGLITE_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`迁移超时\n${output}`));
      }, 5_000);
      child.once('exit', code => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    assert.equal(exitCode, 0, output);

    const upgraded = await PGlite.create(dataDir);
    const tables = await upgraded.query<{ definitions: string | null; events: string | null }>(
      `SELECT to_regclass('game_event_definitions')::text definitions,to_regclass('game_events')::text events`,
    );
    const migrations = await upgraded.query<{ name: string }>(
      `SELECT name FROM schema_migrations WHERE name IN ('004_operational_analytics.sql','005_project_defined_events.sql') ORDER BY name`,
    );
    assert.deepEqual(tables.rows[0], { definitions: 'game_event_definitions', events: 'game_events' });
    assert.deepEqual(migrations.rows.map(item => item.name), ['004_operational_analytics.sql', '005_project_defined_events.sql']);
    await upgraded.close();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
