import { LRUCache } from "lru-cache";
import type { TokenCheckResult } from "../analysis/token-checker.js";

const cache = new LRUCache<string, TokenCheckResult>({
  max: 10_000,
  ttl: 5 * 60 * 1000, // 5 minutes
});

export function getCached(mint: string): TokenCheckResult | undefined {
  return cache.get(mint);
}

export function setCached(mint: string, result: TokenCheckResult): void {
  cache.set(mint, result);
}

export function cacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: 10_000 };
}

export function clearCache(): void {
  cache.clear();
}
