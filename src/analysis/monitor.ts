import { PublicKey } from "@solana/web3.js";
import { checkToken, type TokenCheckResult } from "./token-checker.js";
import {
  detectChanges,
  generateAlerts,
  type ChangeReport,
  type MonitorAlert,
} from "./delta.js";
import {
  getMonitorHistory,
  setMonitorHistory,
} from "../utils/monitor-cache.js";
import { ApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface MonitorTokenResult {
  mint: string;
  name: string | null;
  symbol: string | null;
  checked_at: string;
  cached_at: string | null;
  risk_score: number;
  risk_level: string;
  checks: TokenCheckResult["checks"];
  changes: ChangeReport | null;
}

export interface MonitorTokenError {
  mint: string;
  error: { code: string; message: string };
}

export interface MonitorResponse {
  monitored_at: string;
  token_count: number;
  tokens: MonitorTokenResult[];
  alerts: MonitorAlert[];
  errors: MonitorTokenError[];
}

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "WARNING", "INFO"];

export async function monitorTokens(
  mints: string[],
): Promise<MonitorResponse> {
  // Validate all mints upfront
  for (const mint of mints) {
    try {
      new PublicKey(mint);
    } catch {
      throw new ApiError(
        "INVALID_MINT_ADDRESS",
        `Invalid Solana mint address: ${mint}`,
      );
    }
  }

  if (mints.length > 10) {
    throw new ApiError(
      "TOO_MANY_MINTS",
      `Maximum 10 mints per request, got ${mints.length}`,
    );
  }

  // Run all checks in parallel — checkToken handles caching + singleflight
  const settled = await Promise.allSettled(
    mints.map((mint) => checkToken(mint)),
  );

  const tokens: MonitorTokenResult[] = [];
  const alerts: MonitorAlert[] = [];
  const errors: MonitorTokenError[] = [];

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const outcome = settled[i];

    if (outcome.status === "rejected") {
      const err = outcome.reason;
      logger.warn({ err, mint }, "Monitor: token check failed");
      errors.push({
        mint,
        error: {
          code: err instanceof ApiError ? err.code : "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : "Unknown error",
        },
      });
      continue;
    }

    const { result, fromCache } = outcome.value;

    // Delta detection against monitor history
    const previous = getMonitorHistory(mint);
    const changes = previous ? detectChanges(previous, result) : null;
    const tokenAlerts = generateAlerts(mint, result.symbol, changes);

    // Update monitor history with current snapshot
    setMonitorHistory(mint, result);

    // Strip internal _summary field
    const { _summary, ...publicResult } = result;

    tokens.push({
      mint: publicResult.mint,
      name: publicResult.name,
      symbol: publicResult.symbol,
      checked_at: publicResult.checked_at,
      cached_at: publicResult.cached_at,
      risk_score: publicResult.risk_score,
      risk_level: publicResult.risk_level,
      checks: publicResult.checks,
      changes,
    });

    alerts.push(...tokenAlerts);
  }

  // Sort alerts: CRITICAL first
  alerts.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) -
      SEVERITY_ORDER.indexOf(b.severity),
  );

  return {
    monitored_at: new Date().toISOString(),
    token_count: tokens.length,
    tokens,
    alerts,
    errors,
  };
}
