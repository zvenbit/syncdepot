import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseClient } from './db.js';

export type MigrationPool = {
  connect(): Promise<DatabaseClient>;
};

export async function runMigrations(options: {
  pool: MigrationPool;
  databaseMode: 'postgres' | 'pglite';
  directory?: string;
  log?: (message: string) => void;
}): Promise<void> {
  const directory = options.directory || path.resolve('migrations');
  const log = options.log || (() => undefined);
  const client = await options.pool.connect();
  try {
    if (options.databaseMode === 'postgres') await client.query(`SELECT pg_advisory_lock(hashtext('syncdepot:migrations'))`);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum char(64)');
    for (const name of (await fs.readdir(directory)).filter(item => item.endsWith('.sql')).sort()) {
      const sql = await fs.readFile(path.join(directory, name), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const applied = (await client.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (applied) {
        if (applied.checksum && applied.checksum !== checksum) throw new Error(`已应用的迁移 ${name} 内容发生变化，请新增迁移文件`);
        if (!applied.checksum) await client.query('UPDATE schema_migrations SET checksum=$2 WHERE name=$1', [name, checksum]);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
        await client.query('COMMIT');
        log(`applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (options.databaseMode === 'postgres') await client.query(`SELECT pg_advisory_unlock(hashtext('syncdepot:migrations'))`).catch(() => undefined);
    client.release();
  }
}
