import { LRUCache } from "lru-cache";
import type { TokenCheckResult } from "../analysis/token-checker.js";
import { ApiError, type ErrorCode } from "./errors.js";

// === Primary cache (positive results) ===
const cache = new LRUCache<string, TokenCheckResult>({
  max: 10_000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

let hits = 0;
let misses = 0;

export function getCached(mint: string): TokenCheckResult | undefined {
  const result = cache.get(mint);
  if (result) {
    hits++;
  } else {
    misses++;
  }
  return result;
}

export function setCached(mint: string, result: TokenCheckResult): void {
  if (result.degraded) return;
  cache.set(mint, result);
}

export function cacheStats(): {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: string;
} {
  const total = hits + misses;
  return {
    size: cache.size,
    maxSize: 10_000,
    hits,
    misses,
    hitRate: total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : "N/A",
  };
}

// === Singleflight (in-flight dedup) ===
const inflight = new Map<string, Promise<TokenCheckResult>>();

export function getInflight(
  mint: string,
): Promise<TokenCheckResult> | undefined {
  return inflight.get(mint);
}

const SINGLEFLIGHT_TIMEOUT_MS = 15_000;

export function setInflight(mint: string, p: Promise<TokenCheckResult>): void {
  const timeout = new Promise<TokenCheckResult>((_, reject) =>
    setTimeout(() => {
      inflight.delete(mint);
      reject(new Error("Analysis timed out"));
    }, SINGLEFLIGHT_TIMEOUT_MS),
  );
  const race = Promise.race([p, timeout]);
  inflight.set(mint, race);
  p.finally(() => inflight.delete(mint));
}

// === Negative cache (error-aware TTL) ===
const NEGATIVE_TTL_MS: Partial<Record<ErrorCode, number>> = {
  TOKEN_NOT_FOUND: 15_000, // May resolve on retry (transient RPC null)
  RPC_ERROR: 5_000, // Transient, retry fast
};
const NEGATIVE_TTL_DEFAULT_MS = 30_000;

const negativeCache = new LRUCache<string, ApiError>({
  max: 1_000,
  ttl: NEGATIVE_TTL_DEFAULT_MS, // Fallback; per-item TTL overrides below
});

export function getNegativeCached(mint: string): ApiError | undefined {
  return negativeCache.get(mint);
}

export function setNegativeCached(mint: string, err: ApiError): void {
  const ttl = NEGATIVE_TTL_MS[err.code] ?? NEGATIVE_TTL_DEFAULT_MS;
  negativeCache.set(mint, err, { ttl });
}

// === Clear all caches (for tests) ===
export function clearCache(): void {
  cache.clear();
  inflight.clear();
  negativeCache.clear();
  hits = 0;
  misses = 0;
}
