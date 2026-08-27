import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import { resolveRowCount } from '../../src/result.js';
import type { DatabaseClient, DatabaseResult } from '../../src/db.js';

export type TestDatabase = {
  query: DatabaseClient['query'];
  transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const database = await PGlite.create();
  let transactionTail: Promise<void> = Promise.resolve();
  const query = async <R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<DatabaseResult<R>> => {
    const result = await database.query(text, params);
    return {
      rows: result.rows as R[],
      rowCount: resolveRowCount(result.rows.length, result.affectedRows),
    };
  };

  const migrationNames = (await fs.readdir(path.resolve('migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrationNames) {
    await database.exec(await fs.readFile(path.resolve('migrations', name), 'utf8'));
  }

  return {
    query,
    async transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      await query('BEGIN');
      try {
        const result = await work({ query, release() {} });
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      } finally {
        release();
      }
    },
    close: () => database.close(),
  };
}
