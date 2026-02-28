# TokenSafe Integration Guide

**Audience:** AI agents and the developers who build them.

**Base URL:** `https://tokensafe-production.up.railway.app`

## Quick Start

### Free check (no wallet needed)

```bash
curl 'https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112'
```

### Paid check (x402 — requires USDC wallet)

```typescript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const keypair = await createKeyPairSignerFromBytes(base58.decode(process.env.SVM_PRIVATE_KEY!));
const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(keypair) });
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch("https://tokensafe-production.up.railway.app/v1/check?mint=TOKEN_MINT");
const data = await res.json();
// data.risk_score, data.risk_level, data.checks, data.changes, data.alerts
```

## How Payment Works

TokenSafe uses the [x402 protocol](https://github.com/coinbase/x402). No API keys, no accounts. Payment is authentication.

1. Agent sends `GET /v1/check?mint=<MINT>` with no auth headers
2. Server returns `402 Payment Required` with a `PAYMENT-REQUIRED` header
3. Agent's x402 client automatically signs a USDC transfer ($0.008)
4. Agent retries the request with `PAYMENT-SIGNATURE` header
5. Facilitator verifies and settles on-chain (~400ms)
6. Server returns `200 OK` with full token safety data + `PAYMENT-RESPONSE` header

The `@x402/fetch` package handles steps 2-5 automatically — your code just calls `paidFetch(url)`.

### 402 Response Format

When a request requires payment, the server returns HTTP 402 with a base64-encoded JSON payload in the `PAYMENT-REQUIRED` header:

```json
{
  "scheme": "exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "maxAmountRequired": "8000",
  "resource": "https://tokensafe-production.up.railway.app/v1/check",
  "description": "Solana token safety check",
  "payTo": "<TREASURY_WALLET>",
  "asset": {
    "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  },
  "maxTimeoutSeconds": 300
}
```

- `maxAmountRequired`: `"8000"` = $0.008 USDC (6 decimals)
- `asset.address`: USDC on Solana mainnet
- `network`: Solana mainnet in CAIP-2 format

## Wallet Setup

You need a Solana wallet with USDC for payments.

```bash
npm install @solana/kit @scure/base @x402/fetch @x402/svm
```

```typescript
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const keypairBytes = base58.decode(process.env.SVM_PRIVATE_KEY!);
const keypair = await createKeyPairSignerFromBytes(keypairBytes);
```

Fund the wallet with USDC on Solana mainnet. Each check costs $0.008 USDC (8000 raw units).

## Endpoints

### `GET /v1/check?mint=<MINT>` — Full Safety Analysis ($0.008 USDC)

Returns comprehensive risk assessment for a single Solana token. Requires x402 payment.

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `mint` | string | Token mint address |
| `name` | string \| null | Token name from metadata |
| `symbol` | string \| null | Token symbol |
| `checked_at` | string | ISO 8601 timestamp |
| `cached_at` | string \| null | Non-null when served from cache |
| `risk_score` | number | 0-100 (0 = safest) |
| `risk_level` | string | LOW / MODERATE / HIGH / CRITICAL / EXTREME |
| `risk_factors` | string[] | Human-readable list of detected risks |
| `summary` | string | Risk summary |
| `degraded` | boolean | True if any check was unavailable |
| `degraded_checks` | string[] | Names of checks that failed (empty if not degraded) |
| `rpc_slot` | number | Solana slot number at time of analysis |
| `methodology_version` | string | Scoring algorithm version |
| `response_signature` | string | Ed25519 signature over `{mint, checked_at, rpc_slot, risk_score}` |
| `signer_pubkey` | string | Hex-encoded public key for signature verification |
| `checks` | object | Detailed per-check results (see below) |
| `changes` | object \| null | Delta report vs previous check (null on first check or cache hit) |
| `alerts` | array | Severity-ranked alerts for significant changes |

**Checks object:**

| Check | Key fields |
|-------|------------|
| `mint_authority` | `status` (RENOUNCED/ACTIVE), `authority`, `risk` |
| `freeze_authority` | `status` (RENOUNCED/ACTIVE), `authority`, `risk` |
| `supply` | `total`, `decimals` |
| `top_holders` | `top_10_percentage`, `top_1_percentage`, `top_holders_detail`, `holder_count_estimate`, `note` |
| `liquidity` | `has_liquidity`, `primary_pool`, `pool_address`, `price_impact_pct`, `liquidity_rating`, `lp_locked`, `lp_lock_percentage`, `lp_mint`, `lp_locker` |
| `metadata` | `status`, `mutable`, `update_authority`, `has_uri`, `uri`, `risk` |
| `honeypot` | `status`, `can_sell`, `sell_tax_bps`, `risk` |
| `token_age_hours` | Hours since creation (null if unknown) |
| `token_age_minutes` | Minutes since creation (null if unknown) |
| `created_at` | ISO 8601 creation timestamp (null if unknown) |
| `token_program` | SPL Token or Token-2022 program address |
| `is_token_2022` | Whether token uses Token-2022 |
| `token_2022_extensions` | Array of extension details (null if none) |

**Changes object (when non-null):**

| Field | Type | Description |
|-------|------|-------------|
| `previous_checked_at` | string | Timestamp of previous check |
| `risk_score_delta` | number | Score change (positive = riskier) |
| `previous_risk_score` | number | Score at previous check |
| `previous_risk_level` | string | Level at previous check |
| `changed_fields` | array | `{ field, previous, current }` for each changed check |

**Alert object:**

| Field | Type | Description |
|-------|------|-------------|
| `mint` | string | Token mint address |
| `symbol` | string \| null | Token symbol |
| `severity` | string | HIGH or MEDIUM |
| `message` | string | Human-readable description of the change |

### `GET /v1/check/lite?mint=<MINT>` — Quick Screening (Free)

Rate-limited to 10 requests/minute per IP. Returns a risk preview with an upgrade CTA.

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `mint` | string | Token mint address |
| `name` | string \| null | Token name |
| `symbol` | string \| null | Token symbol |
| `risk_score` | number | 0-100 (0 = safest) |
| `risk_level` | string | LOW / MODERATE / HIGH / CRITICAL / EXTREME |
| `summary` | string | Risk summary |
| `degraded` | boolean | True if any check was unavailable |
| `is_token_2022` | boolean | Whether token uses Token-2022 |
| `has_risky_extensions` | boolean | Whether risky Token-2022 extensions detected |
| `full_report` | object | `{ url, price_usd, payment_protocol, includes }` — structured CTA for full analysis |

### `GET /health` — Server Status (Free)

Returns server status, version, uptime, cache stats, `signer_pubkey` for response signature verification, `facilitator_url`, and available API versions.

### `POST /mcp` — MCP Streamable HTTP (Free)

MCP endpoint for tool discovery by AI agents (Claude Desktop, Cursor, Windsurf).

**Required headers:**
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

**Available tools:**

| Tool | Description |
|------|-------------|
| `solana_token_safety_check` | Free safety check — risk score, summary, Token-2022 detection. Full report via x402 REST API at `/v1/check` |

### `GET /.well-known/x402` — Discovery Document (Free)

Returns x402 discovery metadata for automated service registration. Includes available resources, pricing, rate limits, and checks performed.

## Risk Score Interpretation

| Score | Level | Action |
|-------|-------|--------|
| 0-20 | LOW | Safe to interact |
| 21-40 | MODERATE | Proceed with caution |
| 41-60 | HIGH | Significant risk — pay for full report to review `risk_factors` |
| 61-80 | CRITICAL | Do not trade |
| 81-100 | EXTREME | Confirmed scam/honeypot |

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `MISSING_REQUIRED_PARAM` | 400 | Required query parameter not provided |
| `INVALID_MINT_ADDRESS` | 400 | Mint address is not valid base58 |
| `TOKEN_NOT_FOUND` | 404 | Mint account doesn't exist on chain |
| `RPC_ERROR` | 503 | Solana RPC unavailable — retry later |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests — check `X-RateLimit-Reset` header |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

All errors return structured JSON: `{ "error": { "code": "...", "message": "...", "details": "..." } }`

## Response Headers

| Header | Description |
|--------|-------------|
| `X-Cache` | HIT (cached, < 5min TTL) or MISS (fresh analysis) |
| `X-Response-Time` | Server processing time |
| `X-Request-ID` | Unique request identifier |
| `X-RateLimit-Limit` | Requests allowed per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when limit resets |

## Verifying Response Signatures

Each `/v1/check` response includes `response_signature` and `signer_pubkey`. To verify:

1. Get the signer's public key from `/health` response (`signer_pubkey` field, hex-encoded ed25519 key)
2. Reconstruct the signed payload: `JSON.stringify({ mint, checked_at, rpc_slot, risk_score })`
3. SHA-256 hash the payload
4. Verify the ed25519 signature against the hash

```typescript
import crypto from "node:crypto";

const payload = JSON.stringify({
  mint: data.mint,
  checked_at: data.checked_at,
  rpc_slot: data.rpc_slot,
  risk_score: data.risk_score,
});
const digest = crypto.createHash("sha256").update(payload).digest();
const pubKey = crypto.createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"), // Ed25519 SPKI header
    Buffer.from(data.signer_pubkey, "hex"),
  ]),
  format: "der",
  type: "spki",
});
const valid = crypto.verify(null, digest, pubKey, Buffer.from(data.response_signature, "hex"));
```

## Caching

Results are cached for 5 minutes. Repeated checks within this window return `X-Cache: HIT` instantly. You still pay per request — the cache saves latency, not cost.
