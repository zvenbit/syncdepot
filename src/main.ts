import { app, bootstrap, shutdown } from './server.js';
import { databaseMode, pool } from './db.js';
import { runMigrations } from './migration-runner.js';

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

runMigrations({ pool, databaseMode, log: message => app.log.info(message) }).then(bootstrap).catch(async error => {
  app.log.error(error);
  await pool.end();
  process.exit(1);
});
