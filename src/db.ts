import pg, { type QueryResultRow } from 'pg';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { resolveRowCount } from './result.js';

if (existsSync('.env')) process.loadEnvFile('.env');

export type DatabaseResult<R extends QueryResultRow = QueryResultRow> = {
  rows: R[];
  rowCount: number;
};

export type DatabaseClient = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<DatabaseResult<R>>;
  release(): void;
};

const externalUrl = process.env.DATABASE_URL?.trim();
export const databaseMode = externalUrl ? 'postgres' : 'pglite';
const embeddedDataDir = process.env.PGLITE_DATA_DIR || '.data/game-center';

if (!externalUrl) mkdirSync(path.dirname(path.resolve(embeddedDataDir)), { recursive: true });

const postgresPool = externalUrl ? new pg.Pool({ connectionString: externalUrl }) : null;
const embedded = externalUrl
  ? null
  : await PGlite.create(embeddedDataDir);

async function execute<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<DatabaseResult<R>> {
  if (postgresPool) {
    const result = await postgresPool.query<R>(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  const statementCount = text.split(';').filter(statement => statement.trim()).length;
  if (params.length === 0 && statementCount > 1) {
    const results = await embedded!.exec(text);
    const last = results.at(-1);
    return {
      rows: (last?.rows || []) as R[],
      rowCount: resolveRowCount(last?.rows.length ?? 0, last?.affectedRows),
    };
  }

  const result = await embedded!.query<R>(text, params);
  return {
    rows: result.rows,
    rowCount: resolveRowCount(result.rows.length, result.affectedRows),
  };
}

export const query = execute;

export const pool = {
  query: execute,
  async connect(): Promise<DatabaseClient> {
    if (postgresPool) {
      const client = await postgresPool.connect();
      return {
        async query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
          const result = await client.query<R>(text, params);
          return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        },
        release: () => client.release(),
      };
    }
    return { query: execute, release: () => undefined };
  },
  async end(): Promise<void> {
    if (postgresPool) await postgresPool.end();
    else await embedded?.close();
  },
};

let embeddedTransactionTail: Promise<void> = Promise.resolve();

export async function transaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  let releaseEmbedded: (() => void) | undefined;
  if (!postgresPool) {
    const previous = embeddedTransactionTail;
    embeddedTransactionTail = new Promise<void>(resolve => { releaseEmbedded = resolve; });
    await previous;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    releaseEmbedded?.();
  }
}
