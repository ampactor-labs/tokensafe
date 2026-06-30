import client from "prom-client";
import { registry } from "./metrics.js";
import { logger } from "./logger.js";
import { paidEntries } from "../discovery/catalog.js";

/**
 * Revenue signal — an unambiguous read on whether discovery converts to money.
 *
 * Bot probes only ever produce 402s; a real payer produces a 200 on a paid
 * route carrying a PAYMENT-RESPONSE settlement receipt. We detect exactly that
 * and emit a distinct, greppable `event:"revenue"` log line (💰) plus
 * Prometheus counters, so settled payments stand out from the 402 noise.
 */

export type RevenueSource = "x402" | "mcp_x402" | "api_key";

export const revenueSettledTotal = new client.Counter({
  name: "tokensafe_revenue_settled_total",
  help: "Total settled paid requests by source and endpoint",
  labelNames: ["source", "endpoint"] as const,
  registers: [registry],
});

export const revenueUsdTotal = new client.Counter({
  name: "tokensafe_revenue_usd_total",
  help: "Cumulative settled revenue in USD by source",
  labelNames: ["source"] as const,
  registers: [registry],
});

// Route path → price USD. Paid HTTP routes from the catalog, plus the paid MCP
// tool (POST /mcp), which charges the /v1/check rate.
const checkPriceUsd = paidEntries.find((e) => e.path === "/v1/check")?.priceUsd;
const routePriceUsd = new Map<string, number>(
  paidEntries.map((e) => [e.path, e.priceUsd]),
);
if (checkPriceUsd !== undefined) routePriceUsd.set("/mcp", checkPriceUsd);

export function isPaidRoute(routePath: string): boolean {
  return routePriceUsd.has(routePath);
}

export function priceUsdForRoute(routePath: string): number {
  return routePriceUsd.get(routePath) ?? 0;
}

interface Bucket {
  count: number;
  usd: number;
}

const ledger: Record<RevenueSource, Bucket> = {
  x402: { count: 0, usd: 0 },
  mcp_x402: { count: 0, usd: 0 },
  api_key: { count: 0, usd: 0 },
};
const byEndpoint: Record<string, number> = {};
let lastPayment: Record<string, unknown> | null = null;
const startedAt = new Date().toISOString();

export interface RecordPaymentOpts {
  source: RevenueSource;
  endpoint: string;
  priceUsd: number;
  payer?: string;
  mint?: string;
  tx?: string;
}

export function recordSettledPayment(opts: RecordPaymentOpts): void {
  const { source, endpoint, priceUsd, payer, mint, tx } = opts;
  const bucket = ledger[source];
  bucket.count += 1;
  bucket.usd += priceUsd;
  byEndpoint[endpoint] = (byEndpoint[endpoint] ?? 0) + 1;
  lastPayment = {
    at: new Date().toISOString(),
    source,
    endpoint,
    price_usd: priceUsd,
    payer,
    tx,
  };

  revenueSettledTotal.labels(source, endpoint).inc();
  if (priceUsd > 0) revenueUsdTotal.labels(source).inc(priceUsd);

  // The signal: a single, distinct line per real payment. Grep `event":"revenue"`.
  logger.info(
    { event: "revenue", source, endpoint, price_usd: priceUsd, payer, mint, tx },
    `💰 settled payment — ${source} ${endpoint} $${priceUsd}`,
  );
}

export function getRevenueSummary() {
  return {
    since: startedAt,
    settled_payments: ledger.x402.count + ledger.mcp_x402.count,
    revenue_usd: Number((ledger.x402.usd + ledger.mcp_x402.usd).toFixed(6)),
    api_key_calls: ledger.api_key.count,
    by_source: ledger,
    by_endpoint: byEndpoint,
    last_payment: lastPayment,
  };
}
