import { config } from "../config.js";

/**
 * Canonical resource catalog — the single source of truth for every
 * machine-readable surface TokenSafe exposes:
 *   - the x402 payment middleware route config (src/x402/middleware.ts)
 *   - GET /openapi.json (+ /swagger.json, /v3/api-docs aliases)
 *   - GET /.well-known/x402
 *   - GET /discovery/resources (+ aggregator path variants)
 *   - GET /llms.txt
 *
 * Prices live here once so the 402 a caller pays can never drift from the
 * price an aggregator indexes.
 */

export type HttpMethod = "GET" | "POST";

export interface ResourceEntry {
  method: HttpMethod;
  path: string;
  /** true → behind the x402 payment gate; false → free endpoint */
  paid: boolean;
  /** price in USD; 0 for free endpoints */
  priceUsd: number;
  /** batch/audit tiers: max mints accepted */
  maxTokens?: number;
  title: string;
  description: string;
  /** OpenAPI / discovery grouping */
  tags: string[];
  /** example query params (GET) — also used as the bazaar discovery input */
  exampleQuery?: Record<string, string>;
  /** example JSON body (POST) — also used as the bazaar discovery input */
  exampleBody?: Record<string, unknown>;
  /** example success payload, surfaced to aggregators */
  outputExample?: Record<string, unknown>;
}

export const EXAMPLE_MINT = "So11111111111111111111111111111111111111112";

const CHECK_OUTPUT_EXAMPLE = {
  mint: EXAMPLE_MINT,
  risk_score: 15,
  risk_level: "LOW",
  summary: "Low risk. All authorities renounced, deep liquidity.",
};

const BATCH_OUTPUT_EXAMPLE = {
  total: 1,
  succeeded: 1,
  failed: 0,
  results: [CHECK_OUTPUT_EXAMPLE],
};

export const catalog: ResourceEntry[] = [
  {
    method: "GET",
    path: "/v1/check",
    paid: true,
    priceUsd: 0.02,
    title: "Full Solana token safety check",
    description:
      "Solana token safety check — mint authority, freeze authority, top holder concentration, liquidity, honeypot detection, metadata mutability, token age, Token-2022 extension risks, rug risk score",
    tags: ["safety-check"],
    exampleQuery: { mint: EXAMPLE_MINT },
    outputExample: CHECK_OUTPUT_EXAMPLE,
  },
  {
    method: "POST",
    path: "/v1/check/batch/small",
    paid: true,
    priceUsd: 0.07,
    maxTokens: 5,
    title: "Batch token safety check (up to 5)",
    description: "Batch token safety check — up to 5 tokens at $0.014/token",
    tags: ["batch"],
    exampleBody: { mints: [EXAMPLE_MINT] },
    outputExample: BATCH_OUTPUT_EXAMPLE,
  },
  {
    method: "POST",
    path: "/v1/check/batch/medium",
    paid: true,
    priceUsd: 0.2,
    maxTokens: 20,
    title: "Batch token safety check (up to 20)",
    description: "Batch token safety check — up to 20 tokens at $0.010/token",
    tags: ["batch"],
    exampleBody: { mints: [EXAMPLE_MINT] },
    outputExample: BATCH_OUTPUT_EXAMPLE,
  },
  {
    method: "POST",
    path: "/v1/check/batch/large",
    paid: true,
    priceUsd: 0.4,
    maxTokens: 50,
    title: "Batch token safety check (up to 50)",
    description: "Batch token safety check — up to 50 tokens at $0.008/token",
    tags: ["batch"],
    exampleBody: { mints: [EXAMPLE_MINT] },
    outputExample: BATCH_OUTPUT_EXAMPLE,
  },
  {
    method: "POST",
    path: "/v1/audit/small",
    paid: true,
    priceUsd: 0.15,
    maxTokens: 10,
    title: "Treasury audit (up to 10)",
    description:
      "Treasury audit — up to 10 tokens with policy evaluation and compliance report",
    tags: ["audit"],
    exampleBody: { mints: [EXAMPLE_MINT] },
  },
  {
    method: "POST",
    path: "/v1/audit/standard",
    paid: true,
    priceUsd: 0.6,
    maxTokens: 50,
    title: "Treasury audit (up to 50)",
    description:
      "Treasury audit — up to 50 tokens with policy evaluation and compliance report",
    tags: ["audit"],
    exampleBody: { mints: [EXAMPLE_MINT] },
  },
  {
    method: "POST",
    path: "/v1/subscribe",
    paid: true,
    priceUsd: 49,
    title: "Pro API key (30 days)",
    description:
      "Self-serve Pro API key valid for 30 days — 6000 checks/month, 200 req/min. Pay once via x402 USDC; use the returned key as the X-API-Key header to skip per-call payment.",
    tags: ["subscription"],
    exampleBody: {},
    outputExample: {
      api_key: "tks_…",
      tier: "pro",
      expires_at: "2026-07-30T00:00:00.000Z",
      monthly_limit: 6000,
    },
  },
  {
    method: "GET",
    path: "/v1/check/lite",
    paid: false,
    priceUsd: 0,
    title: "Free lite safety check",
    description:
      "Free rug risk score, risk level, summary, honeypot and Token-2022 detection. Decision-incomplete subset of the full paid report.",
    tags: ["free"],
    exampleQuery: { mint: EXAMPLE_MINT },
  },
  {
    method: "GET",
    path: "/v1/decide",
    paid: false,
    priceUsd: 0,
    title: "Free SAFE/RISKY/UNKNOWN decision",
    description:
      "Free binary SAFE/RISKY/UNKNOWN decision against a risk-score threshold.",
    tags: ["free"],
    exampleQuery: { mint: EXAMPLE_MINT, threshold: "30" },
  },
  {
    method: "GET",
    path: "/health",
    paid: false,
    priceUsd: 0,
    title: "Health and status",
    description: "Server status, version, network, signer pubkey, cache stats.",
    tags: ["free"],
  },
];

/** The MCP Streamable-HTTP surface — modelled as a first-class discovery resource. */
export const mcpResource = {
  path: "/mcp",
  toolName: "solana_token_safety_check",
  transport: "streamable-http" as const,
  description:
    "Solana token safety scanner MCP tool — free lite rug risk score, summary, and Token-2022 detection over MCP Streamable HTTP.",
  inputSchema: {
    type: "object",
    properties: {
      mint_address: {
        type: "string",
        description: "Solana token mint address in base58 format",
      },
    },
    required: ["mint_address"],
  } as Record<string, unknown>,
  example: { mint_address: EXAMPLE_MINT } as Record<string, unknown>,
};

/** Paid full-check MCP tool — x402-gated, priced at the /v1/check rate. */
export const mcpPaidTool = {
  toolName: "solana_token_safety_check_full",
  transport: "streamable-http" as const,
  pricePath: "/v1/check",
  description:
    "Full Solana token safety report (paid via x402): individual authority addresses, holder breakdown, LP lock identity, honeypot sell tax, and field-level delta detection. Returns an x402 payment challenge when called without payment.",
  inputSchema: {
    type: "object",
    properties: {
      mint_address: {
        type: "string",
        description: "Solana token mint address in base58 format",
      },
    },
    required: ["mint_address"],
  } as Record<string, unknown>,
  example: { mint_address: EXAMPLE_MINT } as Record<string, unknown>,
};

export const paidEntries = catalog.filter((e) => e.paid);

/** Look up the "$X" price string for a catalog path (single source of truth). */
export function priceStringFor(path: string): string {
  const entry = catalog.find((e) => e.path === path && e.paid);
  return entry ? usdToPriceString(entry.priceUsd) : "";
}

/** USDC has 6 decimals — convert a USD price to atomic base-units string. */
export function usdToBaseUnits(usd: number): string {
  return Math.round(usd * 1_000_000).toString();
}

/** The "$0.008" / "$0.30" form the x402 paymentMiddleware `price` helper
 * expects — at least 2 decimals, more when the price needs them. */
export function usdToPriceString(usd: number): string {
  const str = usd.toString();
  const decimals = str.includes(".") ? str.split(".")[1].length : 0;
  return `$${usd.toFixed(Math.max(2, decimals))}`;
}

export interface BazaarInfo {
  info: {
    input: Record<string, unknown>;
    output: { type: "json"; example: Record<string, unknown> };
  };
}

/**
 * The `bazaar` discovery extension for a route — attached to the live 402
 * (PaymentRequired.extensions.bazaar) AND embedded in /discovery/resources
 * metadata. GET routes carry queryParams; POST routes carry a JSON body.
 */
export function buildBazaarInfo(e: ResourceEntry): BazaarInfo {
  const input: Record<string, unknown> =
    e.method === "GET"
      ? { type: "http", method: "GET", queryParams: e.exampleQuery ?? {} }
      : {
          type: "http",
          method: "POST",
          bodyType: "json",
          body: e.exampleBody ?? {},
        };
  return {
    info: {
      input,
      output: { type: "json", example: e.outputExample ?? {} },
    },
  };
}

export interface PaymentRequirementsV2 {
  scheme: string;
  /** CAIP-2 network id, e.g. "solana:5eykt4...". Template-literal type matches
   * the x402 `Network` type so these requirements feed verify/settle directly. */
  network: `${string}:${string}`;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** The x402 v2 `accepts[]` array a discovery item advertises for a paid route. */
export function buildAccepts(e: ResourceEntry): PaymentRequirementsV2[] {
  return [
    {
      scheme: "exact",
      network: config.networkCaip2,
      amount: usdToBaseUnits(e.priceUsd),
      asset: config.usdcMint,
      payTo: config.treasuryWallet,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ];
}
