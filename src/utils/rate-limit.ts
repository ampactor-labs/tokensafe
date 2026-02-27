import type { Request, Response, NextFunction } from "express";
import { ApiError } from "./errors.js";

interface BucketEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, BucketEntry>();

// Purge stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export function clearRateLimitBuckets(): void {
  buckets.clear();
}

let limiterCounter = 0;

export function rateLimiter(limit: number) {
  const windowMs = 60_000; // 1 minute
  const id = String(limiterCounter++);

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const key = `${id}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - bucket.count));
    res.setHeader(
      "X-RateLimit-Reset",
      Math.ceil(bucket.resetAt / 1000).toString(),
    );

    if (bucket.count > limit) {
      const err = new ApiError(
        "RATE_LIMITED",
        `Rate limit exceeded. Try again in ${Math.ceil((bucket.resetAt - now) / 1000)}s`,
      );
      res.status(err.status).json(err.toJSON());
      return;
    }

    next();
  };
}
