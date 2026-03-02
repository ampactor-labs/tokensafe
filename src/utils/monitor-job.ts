import { config } from "../config.js";
import { logger } from "./logger.js";
import {
  listSubscriptions,
  createDelivery,
  touchSubscriptionCheckedAt,
} from "./db.js";
import { checkTokenLite } from "../analysis/token-checker.js";
import { processDeliveryQueue } from "./webhook-delivery.js";

export function startMonitorJob(): NodeJS.Timeout {
  runMonitorCycle();
  return setInterval(runMonitorCycle, config.monitorIntervalMs);
}

export function stopMonitorJob(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}

let isRunning = false;

async function runMonitorCycle(): Promise<void> {
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
        if (liteResult.risk_score >= sub.threshold) {
          const payload = {
            mint,
            risk_score: liteResult.risk_score,
            risk_level: liteResult.risk_level,
            summary: liteResult.summary,
            checked_at: new Date().toISOString(),
          };
          createDelivery(sub.id, mint, JSON.stringify(payload));
          deliveriesCreated++;
        }
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
