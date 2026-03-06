import { Connection } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

let primary: Connection | null = null;
let backup: Connection | null = null;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

const FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 5 * 60 * 1000; // 5 minutes

function makeConnection(url: string): Connection {
  return new Connection(url, {
    commitment: "confirmed",
    fetch: (fetchUrl, init) =>
      fetch(fetchUrl as string, {
        ...(init as RequestInit),
        signal: AbortSignal.timeout(10_000),
      }),
  });
}

export function getConnection(): Connection {
  // If circuit is open and we have a backup, use it
  if (backup && Date.now() < circuitOpenUntil) {
    return backup;
  }

  // Reset circuit if timer expired
  if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    logger.info("RPC circuit breaker reset — trying primary again");
  }

  if (!primary) {
    primary = makeConnection(config.heliusRpcUrl);
  }
  return primary;
}

/**
 * Call this when an RPC request fails. After FAILURE_THRESHOLD consecutive
 * failures, the circuit breaker opens and traffic routes to backup.
 */
export function reportRpcFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD && backup) {
    circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
    logger.warn(
      { consecutiveFailures },
      "RPC circuit breaker OPEN — switching to backup provider",
    );
  }
}

/** Call on successful RPC to reset the failure counter. */
export function reportRpcSuccess(): void {
  if (consecutiveFailures > 0) {
    consecutiveFailures = 0;
  }
}

/** Initialize backup connection if env var is set. */
export function initBackupRpc(): void {
  const backupKey = process.env.HELIUS_API_KEY_BACKUP;
  if (!backupKey) return;

  const backupUrl =
    config.solanaNetwork === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${backupKey}`
      : `https://devnet.helius-rpc.com/?api-key=${backupKey}`;

  backup = makeConnection(backupUrl);
  logger.info("Backup RPC provider configured");
}

/** Reset state for tests. */
export function resetRpcState(): void {
  primary = null;
  backup = null;
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

// ---------------------------------------------------------------------------
// Retry helper for transient RPC failures
// ---------------------------------------------------------------------------

const RETRYABLE_PATTERNS = [
  "timeout",
  "429",
  "503",
  "ECONNRESET",
  "fetch failed",
  "AbortError",
];

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return RETRYABLE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Retry a function exactly once on transient errors (timeout, 429, 503,
 * ECONNRESET, fetch failed). 500ms delay before retry. Credit-constrained:
 * one retry max.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), label },
      "Retrying after transient failure",
    );
    await new Promise((r) => setTimeout(r, 500));
    return fn();
  }
}
