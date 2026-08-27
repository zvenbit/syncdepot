import { databaseMode, pool } from './db.js';
import { runMigrations } from './migration-runner.js';

console.log(`database mode: ${databaseMode}`);
try {
  await runMigrations({ pool, databaseMode, log: console.log });
} finally {
  await pool.end();
}
