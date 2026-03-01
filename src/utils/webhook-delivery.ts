import crypto from "node:crypto";
import { logger } from "./logger.js";
import type { WebhookSubscription, WebhookDelivery } from "./db.js";
import {
  getSubscription,
  markDelivered,
  markFailed,
  getPendingDeliveries,
} from "./db.js";

/**
 * Deliver a single webhook: POST payload with HMAC-SHA256 signature.
 * Returns true on success (2xx), false on failure.
 */
export async function deliverWebhook(
  delivery: WebhookDelivery,
  subscription: WebhookSubscription,
): Promise<boolean> {
  const hmac = crypto
    .createHmac("sha256", subscription.secret_hmac)
    .update(delivery.payload_json)
    .digest("hex");

  try {
    const response = await fetch(subscription.callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TokenSafe-Signature": `sha256=${hmac}`,
        "X-TokenSafe-Event": "token.alert",
      },
      body: delivery.payload_json,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      markDelivered(delivery.id);
      logger.info(
        {
          deliveryId: delivery.id,
          subscriptionId: subscription.id,
          status: response.status,
        },
        "Webhook delivered successfully",
      );
      return true;
    }

    // Non-2xx response
    const nextRetryAt = computeNextRetry(delivery.attempts);
    markFailed(delivery.id, nextRetryAt);
    logger.warn(
      {
        deliveryId: delivery.id,
        subscriptionId: subscription.id,
        status: response.status,
        attempt: delivery.attempts + 1,
        nextRetryAt,
      },
      "Webhook delivery failed (non-2xx)",
    );
    return false;
  } catch (err) {
    const nextRetryAt = computeNextRetry(delivery.attempts);
    markFailed(delivery.id, nextRetryAt);
    logger.warn(
      {
        deliveryId: delivery.id,
        subscriptionId: subscription.id,
        error: err instanceof Error ? err.message : String(err),
        attempt: delivery.attempts + 1,
        nextRetryAt,
      },
      "Webhook delivery failed (network error)",
    );
    return false;
  }
}

/**
 * Compute the next retry timestamp based on current attempt count.
 * attempts 0 -> retry in 1 minute
 * attempts 1 -> retry in 5 minutes
 * attempts 2+ -> null (give up, max 3 total attempts)
 */
function computeNextRetry(attempts: number): string | null {
  if (attempts >= 2) return null;
  const delayMs = attempts === 0 ? 60_000 : 300_000;
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * Process all pending/retryable deliveries in the queue.
 * Returns counts of delivered vs failed.
 */
export async function processDeliveryQueue(): Promise<{
  delivered: number;
  failed: number;
}> {
  const pending = getPendingDeliveries();
  let delivered = 0;
  let failed = 0;

  for (const delivery of pending) {
    const subscription = getSubscription(delivery.subscription_id);

    if (!subscription || !subscription.active) {
      markFailed(delivery.id, null);
      failed++;
      logger.warn(
        {
          deliveryId: delivery.id,
          subscriptionId: delivery.subscription_id,
          reason: subscription ? "inactive" : "not_found",
        },
        "Skipping delivery — subscription unavailable",
      );
      continue;
    }

    const ok = await deliverWebhook(delivery, subscription);
    if (ok) {
      delivered++;
    } else {
      failed++;
    }
  }

  return { delivered, failed };
}
