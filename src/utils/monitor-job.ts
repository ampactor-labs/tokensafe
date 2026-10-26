import { config } from "../config.js";
import { logger } from "./logger.js";
import {
  listSubscriptions,
  getAlertedLevel,
  applyAlertDecision,
  touchSubscriptionCheckedAt,
} from "./db.js";
import { checkTokenLite } from "../analysis/token-checker.js";
import type { RiskLevel } from "../analysis/risk-score.js";
import { processDeliveryQueue } from "./webhook-delivery.js";

const LEVEL_RANK: Record<RiskLevel, number> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
  EXTREME: 4,
};

function rank(level: string): number {
  return LEVEL_RANK[level as RiskLevel] ?? -1;
}

export type AlertReason = "crossed" | "escalated";

/**
 * Alerts are edges, not levels. A mint alerts when its score first reaches the
 * threshold, and again only when its risk level climbs past the worst level
 * already reported. Falling back below the threshold re-arms it.
 *
 * alertedLevel is the worst level reported since the score crossed, or null
 * when it is below (or has never been alerted). nextLevel is what to store.
 */
export function decideAlert(
  alertedLevel: string | null,
  score: number,
  level: string,
  threshold: number,
): { reason: AlertReason | null; nextLevel: string | null } {
  if (score < threshold) return { reason: null, nextLevel: null };
  if (alertedLevel === null) return { reason: "crossed", nextLevel: level };
  if (rank(level) > rank(alertedLevel)) {
    return { reason: "escalated", nextLevel: level };
  }
  return { reason: null, nextLevel: alertedLevel };
}

export function startMonitorJob(): NodeJS.Timeout {
  runMonitorCycle();
  return setInterval(runMonitorCycle, config.monitorIntervalMs);
}

export function stopMonitorJob(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}

let isRunning = false;

export async function runMonitorCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  const cycleName = "monitor-cycle";
  try {
    const allSubs = listSubscriptions().filter((s) => s.active);
    if (allSubs.length === 0) {
      logger.debug({ cycleName }, "No active subscriptions, skipping cycle");
      return;
    }

    const uniqueMints = new Set(allSubs.flatMap((s) => s.mints));
    let mintsChecked = 0;
    let deliveriesCreated = 0;

    for (const mint of uniqueMints) {
      let liteResult;
      try {
        const { result } = await checkTokenLite(mint);
        liteResult = result;
        mintsChecked++;
      } catch (err) {
        logger.warn({ err, mint, cycleName }, "Failed to check mint, skipping");
        continue;
      }

      // Find all active subscriptions watching this mint
      const matchingSubs = allSubs.filter((s) => s.mints.includes(mint));
      for (const sub of matchingSubs) {
        const { reason, nextLevel } = decideAlert(
          getAlertedLevel(sub.id, mint),
          liteResult.risk_score,
          liteResult.risk_level,
          sub.threshold,
        );
        const payload = reason && {
          mint,
          risk_score: liteResult.risk_score,
          risk_level: liteResult.risk_level,
          summary: liteResult.summary,
          checked_at: new Date().toISOString(),
          reason,
          threshold: sub.threshold,
        };
        applyAlertDecision(
          sub.id,
          mint,
          nextLevel,
          payload ? JSON.stringify(payload) : null,
        );
        if (payload) deliveriesCreated++;
        touchSubscriptionCheckedAt(sub.id);
      }
    }

    await processDeliveryQueue();

    logger.info(
      {
        cycleName,
        mintsChecked,
        deliveriesCreated,
        subscriptions: allSubs.length,
        uniqueMints: uniqueMints.size,
      },
      "Monitor cycle complete",
    );
  } catch (err) {
    logger.error({ err, cycleName }, "Monitor cycle failed");
  } finally {
    isRunning = false;
  }
}
