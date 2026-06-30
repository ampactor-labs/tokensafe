import { config } from "../config.js";
import {
  catalog,
  paidEntries,
  mcpResource,
  buildBazaarInfo,
  buildAccepts,
  usdToBaseUnits,
  usdToPriceString,
  type ResourceEntry,
} from "./catalog.js";

/**
 * Builders for every machine-readable discovery document. All are pure
 * functions of the canonical catalog + a base URL, so prices and routes can
 * never drift between what a caller pays and what an aggregator indexes.
 */

// Stable for the life of the process — aggregators read this as "last changed".
const BOOT_TIME = new Date().toISOString();

const SERVICE_TAGS = ["solana", "token-safety", "rug-detection"];

function withQuery(baseUrl: string, e: ResourceEntry): string {
  if (e.method === "GET" && e.exampleQuery) {
    const qs = new URLSearchParams(e.exampleQuery).toString();
    return `${baseUrl}${e.path}?${qs}`;
  }
  return `${baseUrl}${e.path}`;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /.well-known/x402  — x402scan legacy/compatibility manifest
// ─────────────────────────────────────────────────────────────────────────

export function buildWellKnownX402(baseUrl: string): Record<string, unknown> {
  return {
    version: 1,
    resources: paidEntries.map((e) => `${e.method} ${withQuery(baseUrl, e)}`),
    ownershipProofs: config.ownershipProof ? [config.ownershipProof] : [],
    instructions: [
      "# TokenSafe — Solana Token Safety Scanner",
      "",
      "Deterministic on-chain analysis. No third-party APIs, no opaque ML.",
      "Machine-readable spec: GET /openapi.json. Agent guide: GET /llms.txt.",
      "",
      "## Paid endpoints (x402, USDC on Solana)",
      "",
      "| Endpoint | Price | Description |",
      "|----------|-------|-------------|",
      ...paidEntries.map(
        (e) =>
          `| \`${e.method} ${e.path}\` | ${usdToPriceString(e.priceUsd)} USDC | ${e.title} |`,
      ),
      "",
      "## Free endpoints",
      "",
      "| Endpoint | Description |",
      "|----------|-------------|",
      ...catalog
        .filter((e) => !e.paid)
        .map((e) => `| \`${e.method} ${e.path}\` | ${e.title} |`),
      `| \`POST /mcp\` | MCP Streamable HTTP — AI agent tool discovery |`,
      "",
      "## Authentication",
      "",
      "- **x402 (default):** pay per request in USDC. No API key needed.",
      "- **API key (subscription):** include `X-API-Key: tks_...` to skip x402.",
      "",
      "## Support",
      "",
      "GitHub: https://github.com/ampactor-labs/tokensafe",
    ].join("\n"),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /discovery/resources (+ aggregator path variants)
//   — x402 Bazaar DiscoveryResourcesResponse shape (@x402/extensions v2.8)
// ─────────────────────────────────────────────────────────────────────────

export interface DiscoveryQuery {
  type?: string;
  limit?: number;
  offset?: number;
}

export function buildDiscoveryResources(
  baseUrl: string,
  query: DiscoveryQuery = {},
): Record<string, unknown> {
  const items: Record<string, unknown>[] = [];

  if (!query.type || query.type === "http") {
    for (const e of paidEntries) {
      items.push({
        resource: `${baseUrl}${e.path}`,
        type: "http",
        x402Version: config.x402Version,
        accepts: buildAccepts(e),
        lastUpdated: BOOT_TIME,
        metadata: {
          serviceName: "TokenSafe",
          description: e.description,
          tags: [...SERVICE_TAGS, ...e.tags],
          iconUrl: `${baseUrl}/icon.svg`,
          ...buildBazaarInfo(e),
        },
      });
    }
  }

  if (!query.type || query.type === "mcp") {
    items.push({
      resource: `${baseUrl}${mcpResource.path}`,
      type: "mcp",
      x402Version: config.x402Version,
      accepts: [],
      lastUpdated: BOOT_TIME,
      metadata: {
        serviceName: "TokenSafe",
        description: mcpResource.description,
        tags: [...SERVICE_TAGS, "mcp"],
        iconUrl: `${baseUrl}/icon.svg`,
        info: {
          input: {
            type: "mcp",
            toolName: mcpResource.toolName,
            transport: mcpResource.transport,
            inputSchema: mcpResource.inputSchema,
            example: mcpResource.example,
          },
        },
      },
    });
  }

  const total = items.length;
  const offset = Math.max(0, query.offset ?? 0);
  const limit = query.limit && query.limit > 0 ? query.limit : total;
  const page = items.slice(offset, offset + limit);

  return {
    x402Version: config.x402Version,
    items: page,
    pagination: { limit, offset, total },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /openapi.json (+ /swagger.json, /v3/api-docs aliases) — OpenAPI 3.1
// ─────────────────────────────────────────────────────────────────────────

function operationId(e: ResourceEntry): string {
  const slug = e.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `${e.method.toLowerCase()}_${slug}`;
}

export function buildOpenApi(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const e of catalog) {
    const op: Record<string, unknown> = {
      tags: e.tags,
      operationId: operationId(e),
      summary: `${e.title}${e.paid ? ` (${usdToPriceString(e.priceUsd)} USDC)` : " (free)"}`,
      description: e.description,
    };

    if (e.method === "GET" && e.exampleQuery) {
      op.parameters = Object.entries(e.exampleQuery).map(([name, value]) => ({
        name,
        in: "query",
        required: name === "mint",
        schema: { type: "string" },
        example: value,
      }));
    }

    if (e.method === "POST") {
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/BatchRequest" },
            example: e.exampleBody,
          },
        },
      };
    }

    const responses: Record<string, unknown> = {
      "200": {
        description: "Success",
        content: { "application/json": {} },
      },
    };

    if (e.paid) {
      op["x-x402"] = {
        scheme: "exact",
        network: config.networkCaip2,
        price: usdToPriceString(e.priceUsd),
        amount: usdToBaseUnits(e.priceUsd),
        asset: config.usdcMint,
        payTo: config.treasuryWallet,
        maxTimeoutSeconds: 60,
      };
      op["x-payment-info"] = {
        protocols: ["x402"],
        price: { mode: "fixed", currency: "USD", amount: String(e.priceUsd) },
        network: "solana",
        asset: "USDC",
      };
      responses["402"] = { $ref: "#/components/responses/PaymentRequired" };
    }

    op.responses = responses;

    paths[e.path] = { ...(paths[e.path] ?? {}), [e.method.toLowerCase()]: op };
  }

  paths[mcpResource.path] = {
    post: {
      tags: ["mcp"],
      operationId: "post_mcp",
      summary: `MCP Streamable HTTP — tool ${mcpResource.toolName} (free)`,
      description: mcpResource.description,
      responses: {
        "200": {
          description: "JSON-RPC / MCP response",
          content: { "application/json": {} },
        },
      },
    },
  };

  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: "TokenSafe — Solana Token Safety API",
      version: "1.0.0",
      description:
        "Deterministic on-chain Solana token safety analysis. Pay-per-call via x402 (USDC on Solana) or subscription API key. See /.well-known/x402, /llms.txt, and POST /mcp.",
      "x-x402": {
        version: config.x402Version,
        network: config.networkCaip2,
        facilitator: config.facilitatorUrl,
        asset: "USDC",
        assetMint: config.usdcMint,
        payTo: config.treasuryWallet,
      },
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: "safety-check" },
      { name: "batch" },
      { name: "audit" },
      { name: "free" },
      { name: "mcp" },
    ],
    paths,
    components: {
      responses: {
        PaymentRequired: {
          description: "x402 Payment Required",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PaymentRequired" },
            },
          },
        },
      },
      schemas: {
        PaymentRequired: {
          type: "object",
          required: ["x402Version", "accepts"],
          properties: {
            x402Version: { type: "integer", const: 2 },
            error: { type: "string" },
            resource: {
              type: "object",
              properties: {
                url: { type: "string" },
                description: { type: "string" },
                mimeType: { type: "string" },
              },
            },
            accepts: {
              type: "array",
              items: { $ref: "#/components/schemas/PaymentRequirements" },
            },
            extensions: { type: "object" },
          },
        },
        PaymentRequirements: {
          type: "object",
          required: [
            "scheme",
            "network",
            "asset",
            "amount",
            "payTo",
            "maxTimeoutSeconds",
          ],
          properties: {
            scheme: { type: "string", example: "exact" },
            network: {
              type: "string",
              example: config.networkCaip2,
            },
            asset: { type: "string", example: config.usdcMint },
            amount: { type: "string", example: "8000" },
            payTo: { type: "string" },
            maxTimeoutSeconds: { type: "integer", example: 60 },
            extra: { type: "object" },
          },
        },
        SafetyReport: {
          type: "object",
          properties: {
            mint: { type: "string" },
            risk_score: { type: "integer" },
            risk_level: {
              type: "string",
              enum: ["LOW", "MODERATE", "HIGH", "CRITICAL", "EXTREME"],
            },
            summary: { type: "string" },
          },
        },
        BatchRequest: {
          type: "object",
          required: ["mints"],
          properties: {
            mints: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };

  if (config.ownershipProof) {
    doc["x-discovery"] = { ownershipProofs: [config.ownershipProof] };
    doc["x-agentcash-provenance"] = {
      ownershipProofs: [config.ownershipProof],
    };
  }

  return doc;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /llms.txt — Markdown agent guide
// ─────────────────────────────────────────────────────────────────────────

export function buildLlmsTxt(baseUrl: string): string {
  const paid = paidEntries
    .map(
      (e) =>
        `- ${e.method} ${e.path} — ${usdToPriceString(e.priceUsd)} USDC — ${e.title}`,
    )
    .join("\n");
  const free = catalog
    .filter((e) => !e.paid)
    .map((e) => `- ${e.method} ${e.path} — ${e.title}`)
    .join("\n");

  return `# TokenSafe — Solana Token Safety API

> Deterministic on-chain Solana token safety analysis. No third-party ML. Pay-per-call via x402 (USDC on Solana) or subscription API key.

## Machine-readable specs
- OpenAPI 3.1: ${baseUrl}/openapi.json
- x402 discovery: ${baseUrl}/.well-known/x402
- x402 resource list: ${baseUrl}/discovery/resources
- MCP endpoint: ${baseUrl}/mcp (tool \`${mcpResource.toolName}\`)

## Paid endpoints (x402, USDC on Solana)
${paid}

## Free endpoints
${free}

## Payment
x402 v${config.x402Version}; facilitator ${config.facilitatorUrl}; network ${config.networkCaip2}; asset USDC (${config.usdcMint}).
First request returns 402 with payment requirements; any x402-compatible client signs the USDC transfer and retries.
`;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /.well-known/api-catalog — RFC 9727 linkset
// ─────────────────────────────────────────────────────────────────────────

export function buildApiCatalog(baseUrl: string): Record<string, unknown> {
  return {
    linkset: [
      {
        anchor: baseUrl,
        "service-desc": [
          { href: `${baseUrl}/openapi.json`, type: "application/openapi+json" },
        ],
        "service-doc": [{ href: `${baseUrl}/llms.txt`, type: "text/markdown" }],
      },
    ],
  };
}
