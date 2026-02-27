import { LRUCache } from "lru-cache";
import type { TokenCheckResult } from "../analysis/token-checker.js";

// Stores the last monitor snapshot per mint for delta detection.
// Separate from the 5-min analysis cache — this has 24h TTL and
// only stores results returned via /v1/monitor.
const monitorHistory = new LRUCache<string, TokenCheckResult>({
  max: 5_000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

let historyHits = 0;
let historyMisses = 0;

export function getMonitorHistory(
  mint: string,
): TokenCheckResult | undefined {
  const result = monitorHistory.get(mint);
  if (result) {
    historyHits++;
  } else {
    historyMisses++;
  }
  return result;
}

export function setMonitorHistory(
  mint: string,
  result: TokenCheckResult,
): void {
  monitorHistory.set(mint, result);
}

export function monitorCacheStats(): {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: string;
} {
  const total = historyHits + historyMisses;
  return {
    size: monitorHistory.size,
    maxSize: 5_000,
    hits: historyHits,
    misses: historyMisses,
    hitRate: total > 0 ? `${((historyHits / total) * 100).toFixed(1)}%` : "N/A",
  };
}

export function clearMonitorCache(): void {
  monitorHistory.clear();
  historyHits = 0;
  historyMisses = 0;
}
