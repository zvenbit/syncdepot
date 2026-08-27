import type { DatabaseClient } from './db.js';

export type RateLimitOutcome = { allowed: boolean; remaining: number; resetAt: number };
export type RateLimitStore = {
  consume(key: string, limit: number, windowMs: number, now?: number): Promise<RateLimitOutcome>;
};

export function createMemoryRateLimitStore(): RateLimitStore {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(key, limit, windowMs, now = Date.now()) {
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
      if (buckets.size > 10_000) {
        for (const [id, value] of buckets) if (value.resetAt <= now) buckets.delete(id);
      }
      return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt };
    },
  };
}

export function createDatabaseRateLimitStore(query: DatabaseClient['query']): RateLimitStore {
  return {
    async consume(key, limit, windowMs, now = Date.now()) {
      const nowIso = new Date(now).toISOString();
      const resetIso = new Date(now + windowMs).toISOString();
      const row = (await query<{ count: number; reset_at: string }>(
        `INSERT INTO rate_limit_buckets(bucket_key,count,reset_at) VALUES($1,1,$3)
         ON CONFLICT(bucket_key) DO UPDATE SET
           count=CASE WHEN rate_limit_buckets.reset_at<=$2 THEN 1 ELSE rate_limit_buckets.count+1 END,
           reset_at=CASE WHEN rate_limit_buckets.reset_at<=$2 THEN $3 ELSE rate_limit_buckets.reset_at END
         RETURNING count,reset_at`,
        [key, nowIso, resetIso],
      )).rows[0]!;
      const count = Number(row.count);
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetAt: new Date(row.reset_at).getTime(),
      };
    },
  };
}
