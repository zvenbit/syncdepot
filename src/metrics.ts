import type { DatabaseClient } from './db.js';

type Metric = { gameId: string; route: string; statusCode: number; durationMs: number; recordedAt?: Date };

export function createMetricsCollector(options: {
  query: DatabaseClient['query'];
  flushMs?: number;
  maxQueue?: number;
  autoStart?: boolean;
  onError?: (error: unknown) => void;
}) {
  let queue: Metric[] = [];
  let activeFlush: Promise<void> | null = null;
  let dropped = 0;
  const flushMs = options.flushMs || 1000;
  const maxQueue = options.maxQueue || 10_000;

  async function flushBatch(): Promise<void> {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    const grouped = new Map<string, { gameId: string; route: string; date: string; requests: number; errors: number; duration: number }>();
    for (const metric of batch) {
      const date = (metric.recordedAt || new Date()).toISOString().slice(0, 10);
      const key = `${date}:${metric.gameId}:${metric.route}`;
      const item = grouped.get(key) || { gameId: metric.gameId, route: metric.route, date, requests: 0, errors: 0, duration: 0 };
      item.requests += 1;
      item.errors += metric.statusCode >= 400 ? 1 : 0;
      item.duration += metric.durationMs;
      grouped.set(key, item);
    }
    try {
      await Promise.all([...grouped.values()].map(item => options.query(
        `INSERT INTO api_metrics_daily(metric_date,game_id,route,requests,errors,total_duration_ms)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(metric_date,game_id,route) DO UPDATE SET
         requests=api_metrics_daily.requests+excluded.requests,
         errors=api_metrics_daily.errors+excluded.errors,
         total_duration_ms=api_metrics_daily.total_duration_ms+excluded.total_duration_ms`,
        [item.date, item.gameId, item.route, item.requests, item.errors, item.duration],
      )));
    } catch (error) {
      const combined = [...batch, ...queue];
      if (combined.length > maxQueue) dropped += combined.length - maxQueue;
      queue = combined.slice(-maxQueue);
      throw error;
    }
  }

  const timer = options.autoStart === false ? null : setInterval(() => {
    void flush().catch(error => options.onError?.(error));
  }, flushMs);
  timer?.unref();

  function flush(): Promise<void> {
    if (!activeFlush) activeFlush = flushBatch().finally(() => { activeFlush = null; });
    return activeFlush;
  }

  return {
    record(metric: Metric): void {
      if (queue.length >= maxQueue) {
        dropped += 1;
        return;
      }
      queue.push(metric);
    },
    flush,
    stats(): { queued: number; dropped: number } { return { queued: queue.length, dropped }; },
    async close(): Promise<void> {
      if (timer) clearInterval(timer);
      do { await flush(); } while (queue.length);
    },
  };
}
