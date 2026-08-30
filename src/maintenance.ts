import type { DatabaseClient } from './db.js';

export type RetentionOptions = {
  auditDays: number;
  eventDays?: number;
  archiveHistoryDays?: number;
  configHistoryDays?: number;
};

export async function runRetention(query: DatabaseClient['query'], options: RetentionOptions) {
  const idempotency = await query('DELETE FROM idempotency_records WHERE expires_at<now()');
  const rateLimits = await query('DELETE FROM rate_limit_buckets WHERE reset_at<now()');
  const audit = options.auditDays > 0
    ? await query(`DELETE FROM audit_logs WHERE created_at<now()-($1::text||' days')::interval`, [options.auditDays])
    : { rowCount: 0 };
  const events = (options.eventDays || 0) > 0
    ? await query(`DELETE FROM game_events WHERE received_at<now()-($1::text||' days')::interval`, [options.eventDays])
    : { rowCount: 0 };
  const archiveHistory = (options.archiveHistoryDays || 0) > 0
    ? await query(`DELETE FROM archive_revisions WHERE created_at<now()-($1::text||' days')::interval`, [options.archiveHistoryDays])
    : { rowCount: 0 };
  const configHistory = (options.configHistoryDays || 0) > 0
    ? await query(`DELETE FROM config_revisions WHERE status='superseded' AND created_at<now()-($1::text||' days')::interval`, [options.configHistoryDays])
    : { rowCount: 0 };
  return {
    idempotency: idempotency.rowCount,
    rateLimits: rateLimits.rowCount,
    audit: audit.rowCount,
    events: events.rowCount,
    archiveHistory: archiveHistory.rowCount,
    configHistory: configHistory.rowCount,
  };
}

export function startRetentionScheduler(options: {
  query: DatabaseClient['query'];
  retention: RetentionOptions;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const run = () => runRetention(options.query, options.retention).catch(error => options.onError?.(error));
  void run();
  const timer = setInterval(() => void run(), options.intervalMs || 24 * 3600 * 1000);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
