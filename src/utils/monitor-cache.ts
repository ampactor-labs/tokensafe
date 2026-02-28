import { LRUCache } from "lru-cache";
import type { TokenCheckResult } from "../analysis/token-checker.js";

// Stores snapshots for delta detection on subsequent /v1/check calls.
// Separate from the 5-min analysis cache — this has 24h TTL and
// persists previous results for change comparison.
const checkHistory = new LRUCache<string, TokenCheckResult>({
  max: 5_000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

let historyHits = 0;
let historyMisses = 0;

export function getCheckHistory(mint: string): TokenCheckResult | undefined {
  const result = checkHistory.get(mint);
  if (result) {
    historyHits++;
  } else {
    historyMisses++;
  }
  return result;
}

export function setCheckHistory(mint: string, result: TokenCheckResult): void {
  checkHistory.set(mint, result);
}

export function checkHistoryCacheStats(): {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: string;
} {
  const total = historyHits + historyMisses;
  return {
    size: checkHistory.size,
    maxSize: 5_000,
    hits: historyHits,
    misses: historyMisses,
    hitRate: total > 0 ? `${((historyHits / total) * 100).toFixed(1)}%` : "N/A",
  };
}

export function clearCheckHistory(): void {
  checkHistory.clear();
  historyHits = 0;
  historyMisses = 0;
}
