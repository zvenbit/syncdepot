import type { DatabaseClient } from './db.js';

export async function runRetention(query: DatabaseClient['query'], options: { auditDays: number }) {
  const idempotency = await query('DELETE FROM idempotency_records WHERE expires_at<now()');
  const rateLimits = await query('DELETE FROM rate_limit_buckets WHERE reset_at<now()');
  const audit = options.auditDays > 0
    ? await query(`DELETE FROM audit_logs WHERE created_at<now()-($1::text||' days')::interval`, [options.auditDays])
    : { rowCount: 0 };
  return { idempotency: idempotency.rowCount, rateLimits: rateLimits.rowCount, audit: audit.rowCount };
}

export function startRetentionScheduler(options: {
  query: DatabaseClient['query'];
  auditDays: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const run = () => runRetention(options.query, { auditDays: options.auditDays }).catch(error => options.onError?.(error));
  void run();
  const timer = setInterval(() => void run(), options.intervalMs || 24 * 3600 * 1000);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
