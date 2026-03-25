# TokenSafe Integration Guide

**Audience:** AI agents and the developers who build them.

**Base URL:** `https://tokensafe-production.up.railway.app`

## Quick Start

### Free check (no wallet needed)

```bash
curl 'https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112'
```

### Paid check with API key (subscription -- no wallet needed)

```bash
curl -H "X-API-Key: <YOUR_API_KEY>" \
  'https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112'
```

API keys start with `tks_` prefix. Get one from the admin API (see API Key Management below).

### Paid check (x402 -- requires USDC wallet)

```typescript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const keypair = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY!),
);
const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(keypair) });
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch(
  "https://tokensafe-production.up.railway.app/v1/check?mint=TOKEN_MINT",
);
const data = await res.json();
// data.risk_score, data.risk_level, data.checks, data.changes, data.alerts
```

## Authentication

TokenSafe supports two authentication methods for paid endpoints:

1. **x402 micropayments (default):** Pay $0.008 USDC per request. No accounts needed. Payment is authentication.
2. **API key (subscription):** Include `X-API-Key` header to skip x402. Pro ($49/mo): 200 req/min, 6K checks/month. Enterprise ($199/mo): 600 req/min, unlimited checks.

Free endpoints (`/v1/check/lite`, `/v1/decide`, `/health`) require neither.

## How x402 Payment Works

TokenSafe uses the [x402 protocol](https://github.com/coinbase/x402) for per-request payments.

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

| Field                 | Type           | Description                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mint`                | string         | Token mint address                                                                                                                                                                                                                                                                                                                                                                                         |
| `name`                | string \| null | Token name from metadata                                                                                                                                                                                                                                                                                                                                                                                   |
| `symbol`              | string \| null | Token symbol                                                                                                                                                                                                                                                                                                                                                                                               |
| `checked_at`          | string         | ISO 8601 timestamp                                                                                                                                                                                                                                                                                                                                                                                         |
| `cached_at`           | string \| null | Non-null when served from cache                                                                                                                                                                                                                                                                                                                                                                            |
| `risk_score`          | number         | 0-100 (0 = safest)                                                                                                                                                                                                                                                                                                                                                                                         |
| `risk_level`          | string         | LOW / MODERATE / HIGH / CRITICAL / EXTREME                                                                                                                                                                                                                                                                                                                                                                 |
| `risk_factors`        | string[]       | Human-readable list of detected risks                                                                                                                                                                                                                                                                                                                                                                      |
| `summary`             | string         | Risk summary                                                                                                                                                                                                                                                                                                                                                                                               |
| `degraded`            | boolean        | True if any check was unavailable                                                                                                                                                                                                                                                                                                                                                                          |
| `degraded_checks`     | string[]       | Names of checks that failed (empty if not degraded)                                                                                                                                                                                                                                                                                                                                                        |
| `rpc_slot`            | number         | Solana slot number at time of analysis                                                                                                                                                                                                                                                                                                                                                                     |
| `methodology_version` | string         | Scoring algorithm version                                                                                                                                                                                                                                                                                                                                                                                  |
| `response_signature`  | string         | Ed25519 signature over `{mint, checked_at, rpc_slot, risk_score}`                                                                                                                                                                                                                                                                                                                                          |
| `signer_pubkey`       | string         | Hex-encoded public key for signature verification                                                                                                                                                                                                                                                                                                                                                          |
| `score_breakdown`     | object         | Per-check point contributions to `risk_score`. Possible keys: `mint_authority`, `freeze_authority`, `top_holders_10`, `top_holders_1`, `liquidity`, `metadata`, `token_age`, `permanent_delegate`, `transfer_fee`, `honeypot`, `sell_tax`, `uncertainty_top_holders`, `uncertainty_liquidity`, `uncertainty_honeypot`, `uncertainty_token_age`, `uncertainty_metadata`. Only non-zero entries are present. |
| `checks`              | object         | Detailed per-check results (see below)                                                                                                                                                                                                                                                                                                                                                                     |
| `changes`             | object \| null | Delta report vs previous check (null on first check or cache hit)                                                                                                                                                                                                                                                                                                                                          |
| `alerts`              | array          | Severity-ranked alerts for significant changes                                                                                                                                                                                                                                                                                                                                                             |

**Checks object:**

| Check                   | Key fields                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mint_authority`        | `status` (RENOUNCED/ACTIVE), `authority`, `risk`                                                                                                                                                                                 |
| `freeze_authority`      | `status` (RENOUNCED/ACTIVE), `authority`, `risk`                                                                                                                                                                                 |
| `supply`                | `total`, `decimals`                                                                                                                                                                                                              |
| `top_holders`           | `status` (OK/UNAVAILABLE), `top_10_percentage`, `top_1_percentage`, `top_holders_detail` (array of `{address, percentage}`), `holder_count_estimate`, `note`, `risk` (SAFE/HIGH/CRITICAL/UNKNOWN)                                |
| `liquidity`             | **null if unavailable.** `status` (OK/UNAVAILABLE), `has_liquidity`, `primary_pool`, `pool_address`, `price_impact_pct`, `liquidity_rating`, `lp_locked`, `lp_lock_percentage`, `lp_lock_expiry`, `lp_mint`, `lp_locker`, `risk` |
| `metadata`              | **null if unavailable.** `status` (OK/UNAVAILABLE), `mutable`, `update_authority`, `has_uri`, `uri`, `risk`                                                                                                                      |
| `honeypot`              | **null if unavailable.** `status` (OK/UNAVAILABLE), `can_sell`, `sell_tax_bps`, `risk`                                                                                                                                           |
| `token_age_hours`       | Hours since creation (null if unknown)                                                                                                                                                                                           |
| `token_age_minutes`     | Minutes since creation (null if unknown)                                                                                                                                                                                         |
| `created_at`            | ISO 8601 creation timestamp (null if unknown)                                                                                                                                                                                    |
| `token_program`         | SPL Token or Token-2022 program address                                                                                                                                                                                          |
| `is_token_2022`         | Whether token uses Token-2022                                                                                                                                                                                                    |
| `token_2022_extensions` | Array of extension details (null if none)                                                                                                                                                                                        |

**Changes object (when non-null):**

| Field                 | Type   | Description                                           |
| --------------------- | ------ | ----------------------------------------------------- |
| `previous_checked_at` | string | Timestamp of previous check                           |
| `risk_score_delta`    | number | Score change (positive = riskier)                     |
| `previous_risk_score` | number | Score at previous check                               |
| `previous_risk_level` | string | Level at previous check                               |
| `changed_fields`      | array  | `{ field, previous, current }` for each changed check |

**Alert object:**

| Field      | Type           | Description                              |
| ---------- | -------------- | ---------------------------------------- |
| `mint`     | string         | Token mint address                       |
| `symbol`   | string \| null | Token symbol                             |
| `severity` | string         | HIGH or MEDIUM                           |
| `message`  | string         | Human-readable description of the change |

### `GET /v1/check/lite?mint=<MINT>` — Quick Screening (Free)

Rate-limited to 30 requests/minute per IP. Returns a risk preview with an upgrade CTA.

**Response fields:**

| Field                   | Type            | Description                                                                         |
| ----------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `mint`                  | string          | Token mint address                                                                  |
| `name`                  | string \| null  | Token name                                                                          |
| `symbol`                | string \| null  | Token symbol                                                                        |
| `risk_score`            | number          | 0-100 (0 = safest)                                                                  |
| `risk_level`            | string          | LOW / MODERATE / HIGH / CRITICAL / EXTREME                                          |
| `summary`               | string          | Risk summary                                                                        |
| `degraded`              | boolean         | True if any check was unavailable                                                   |
| `degraded_checks`       | string[]        | Names of checks that failed (empty if not degraded)                                 |
| `checks_completed`      | number          | Number of checks that succeeded (out of `checks_total`)                             |
| `checks_total`          | number          | Total checks attempted (currently 6)                                                |
| `is_token_2022`         | boolean         | Whether token uses Token-2022                                                       |
| `has_risky_extensions`  | boolean         | Whether risky Token-2022 extensions detected                                        |
| `can_sell`              | boolean \| null | Whether token can be sold (from honeypot check, null if unavailable)                |
| `authorities_renounced` | boolean         | True if both mint and freeze authorities are renounced                              |
| `has_liquidity`         | boolean         | Whether any liquidity pool was detected                                             |
| `liquidity_rating`      | string \| null  | DEEP / MODERATE / SHALLOW / NONE (null if unavailable)                              |
| `top_10_concentration`  | number \| null  | Top 10 holder percentage (null if unavailable)                                      |
| `token_age_hours`       | number \| null  | Hours since token creation (null if unknown)                                        |
| `risk_score_delta`      | number \| null  | Score change vs previous check (positive = riskier, null on first check)            |
| `previous_risk_score`   | number \| null  | Risk score at previous check (null on first check)                                  |
| `previous_risk_level`   | string \| null  | Risk level at previous check (null on first check)                                  |
| `full_report`           | object          | `{ url, price_usd, payment_protocol, includes }` — structured CTA for full analysis |

### `GET /v1/decide?mint=<MINT>&threshold=N` — Binary Decision (Free)

Rate-limited to 30 requests/minute per IP. Returns a SAFE/RISKY/UNKNOWN decision based on the risk score vs a configurable threshold.

**Query parameters:**

| Param       | Type   | Default    | Description                                             |
| ----------- | ------ | ---------- | ------------------------------------------------------- |
| `mint`      | string | (required) | Solana token mint address                               |
| `threshold` | number | 30         | Risk score threshold (0-100). Score <= threshold = SAFE |

**Response fields:**

| Field             | Type                  | Description                                                                       |
| ----------------- | --------------------- | --------------------------------------------------------------------------------- |
| `mint`            | string                | Token mint address                                                                |
| `decision`        | string                | `SAFE` (score <= threshold), `RISKY` (score > threshold), or `UNKNOWN` (degraded) |
| `risk_score`      | number                | 0-100 (0 = safest)                                                                |
| `risk_level`      | string                | LOW / MODERATE / HIGH / CRITICAL / EXTREME                                        |
| `threshold_used`  | number                | The threshold applied (clamped to 0-100)                                          |
| `note`            | string \| undefined   | Present when `decision` is UNKNOWN — explains degradation and suggests retry      |
| `degraded_checks` | string[] \| undefined | Present when `decision` is UNKNOWN — names of checks that failed                  |
| `full_report`     | object                | Structured CTA for full paid analysis                                             |

### `POST /v1/check/batch/small` — Batch Check, 5 Tokens ($0.025 USDC)

### `POST /v1/check/batch/medium` — Batch Check, 20 Tokens ($0.08 USDC)

### `POST /v1/check/batch/large` — Batch Check, 50 Tokens ($0.15 USDC)

Batch safety analysis with tiered pricing. Requires x402 payment. Send a JSON body with a `mints` array.

**Request body:**

```json
{ "mints": ["So111...", "EPjFW...", "4zMMC..."] }
```

**Response fields:**

| Field        | Type   | Description                                                                                           |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| `total`      | number | Number of mints submitted                                                                             |
| `succeeded`  | number | Number of successful analyses                                                                         |
| `failed`     | number | Number of failed analyses                                                                             |
| `checked_at` | string | ISO 8601 timestamp                                                                                    |
| `results`    | array  | Full `TokenCheckResult` per mint, or `{ mint, status: "error", error: { code, message } }` on failure |

**Pricing:**

| Tier            | Max Tokens | Price  | Per Token |
| --------------- | ---------- | ------ | --------- |
| `/batch/small`  | 5          | $0.025 | $0.005    |
| `/batch/medium` | 20         | $0.08  | $0.004    |
| `/batch/large`  | 50         | $0.15  | $0.003    |

**Error codes:** `TOO_MANY_MINTS` (400) if array exceeds tier limit. `INVALID_MINT_ADDRESS` (400) if any mint is invalid base58.

### `POST /v1/audit/small` — Treasury Audit, 10 Tokens ($0.08 USDC)

### `POST /v1/audit/standard` — Treasury Audit, 50 Tokens ($0.30 USDC)

Run a policy-evaluated audit on a batch of tokens. Requires x402 payment or API key. Returns per-token results, policy violations, aggregate risk, and a signed attestation.

**Request body:**

```json
{
  "mints": ["So111...", "EPjFW..."],
  "policy": {
    "name": "my-policy",
    "rules": [
      {
        "id": "no_rug",
        "field": "risk_score",
        "operator": "gt",
        "value": 60,
        "action": "block",
        "message": "Too risky"
      }
    ]
  }
}
```

`policy` is optional — defaults to the built-in policy (8 rules covering extreme risk, honeypots, authorities, delegate extensions, etc.).

**Response fields:**

| Field                  | Type   | Description                                                      |
| ---------------------- | ------ | ---------------------------------------------------------------- |
| `audit_id`             | string | UUID for this audit (use to fetch report)                        |
| `created_at`           | string | ISO 8601 timestamp                                               |
| `expires_at`           | string | Auto-expires after 90 days                                       |
| `total`                | number | Number of mints submitted                                        |
| `succeeded`            | number | Successful analyses                                              |
| `failed`               | number | Failed analyses                                                  |
| `aggregate_risk_score` | number | Average risk score of succeeded tokens                           |
| `risk_distribution`    | object | `{ LOW: 5, MODERATE: 2, HIGH: 1 }` count per level               |
| `policy_violations`    | array  | `{ rule_id, action, message, actual_value }` per violation       |
| `attestation`          | object | `{ hash, signature, signer_pubkey }` — Ed25519 signed audit hash |
| `results`              | array  | Full `TokenCheckResult` per mint, or error objects               |

**Pricing:**

| Tier              | Max Tokens | Price |
| ----------------- | ---------- | ----- |
| `/audit/small`    | 10         | $0.08 |
| `/audit/standard` | 50         | $0.30 |

### `GET /v1/audit/history` — Audit History (API Key or Bearer)

Returns past audit summaries. Requires `X-API-Key` or admin `Authorization: Bearer`.

**Query parameters:**

| Param   | Type   | Default    | Description                 |
| ------- | ------ | ---------- | --------------------------- |
| `mint`  | string | (optional) | Filter by mint address      |
| `from`  | string | (optional) | ISO 8601 start date         |
| `to`    | string | (optional) | ISO 8601 end date           |
| `limit` | number | 50         | Max results (capped at 100) |

**Response:** Array of `{ id, created_at, expires_at, token_count, aggregate_risk_score, violation_count }`.

### `GET /v1/audit/:id/report` — Compliance Report (API Key or Bearer)

Returns a markdown compliance report for a specific audit.

**Response:** `Content-Type: text/markdown; charset=utf-8`. Report includes executive summary, risk distribution, policy violations, per-token details, and attestation.

```bash
curl -H "X-API-Key: tks_..." https://tokensafe-production.up.railway.app/v1/audit/<AUDIT_ID>/report
```

### `GET /health` — Server Status (Free)

Returns server status, version, uptime, cache stats, `signer_pubkey` for response signature verification, `facilitator_url`, and available API versions.

### `POST /mcp` — MCP Streamable HTTP (Free)

MCP endpoint for tool discovery by AI agents (Claude Desktop, Cursor, Windsurf).

**Required headers:**

- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

**Available tools:**

| Tool                        | Description                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `solana_token_safety_check` | Free safety check — risk score, summary, Token-2022 detection. Full report via x402 REST API at `/v1/check` |

### `GET /metrics` — Prometheus Metrics (Bearer)

Returns Prometheus text-format metrics. Requires `Authorization: Bearer <WEBHOOK_ADMIN_BEARER>`. Returns 404 if bearer not configured.

Metrics include: `tokensafe_http_request_duration_seconds`, `tokensafe_http_requests_total`, `tokensafe_token_checks_total`, `tokensafe_api_key_requests_total`, `tokensafe_cache_hit_ratio`, `tokensafe_degraded_checks_total`, `tokensafe_rpc_latency_seconds`, plus default Node.js process metrics.

### `GET /.well-known/x402` — Discovery Document (Free)

Returns x402 discovery metadata for automated service registration. Includes available resources, pricing, rate limits, and checks performed.

## Risk Score Interpretation

| Score  | Level    | Action                                                          |
| ------ | -------- | --------------------------------------------------------------- |
| 0-20   | LOW      | Safe to interact                                                |
| 21-40  | MODERATE | Proceed with caution                                            |
| 41-60  | HIGH     | Significant risk — pay for full report to review `risk_factors` |
| 61-80  | CRITICAL | Do not trade                                                    |
| 81-100 | EXTREME  | Confirmed scam/honeypot                                         |

## Error Codes

| Code                     | HTTP Status | Meaning                                               |
| ------------------------ | ----------- | ----------------------------------------------------- |
| `MISSING_REQUIRED_PARAM` | 400         | Required query parameter not provided                 |
| `INVALID_MINT_ADDRESS`   | 400         | Mint address is not valid base58                      |
| `TOKEN_NOT_FOUND`        | 404         | Mint account doesn't exist on chain                   |
| `RPC_ERROR`              | 503         | Solana RPC unavailable — retry later                  |
| `RATE_LIMITED`           | 429         | Too many requests -- check `X-RateLimit-Reset` header |
| `INVALID_API_KEY`        | 401         | API key not found or revoked                          |
| `API_KEY_EXPIRED`        | 401         | API key past its expiration date                      |
| `API_KEY_LIMIT_EXCEEDED` | 429         | Monthly usage limit reached for API key tier          |
| `TOO_MANY_MINTS`         | 400         | Batch/audit request exceeds tier's max tokens         |
| `AUDIT_NOT_FOUND`        | 404         | Audit ID not found or expired                         |
| `TIMEOUT`                | 504         | Request timed out after 30 seconds                    |
| `INTERNAL_ERROR`         | 500         | Unexpected server error                               |

All errors return structured JSON: `{ "error": { "code": "...", "message": "...", "details": "..." } }`

## Response Headers

| Header                        | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `X-Cache`                     | HIT (cached, < 5min TTL) or MISS (fresh analysis)                    |
| `X-Response-Time`             | Server processing time                                               |
| `X-Request-ID`                | Unique request identifier                                            |
| `X-RateLimit-Limit`           | Requests allowed per window                                          |
| `X-RateLimit-Remaining`       | Requests remaining in current window                                 |
| `X-RateLimit-Reset`           | Unix timestamp when limit resets                                     |
| `Cache-Control`               | `public, max-age=300` on free endpoints; `private, no-store` on paid |
| `Vary`                        | `Accept-Encoding` on free endpoints                                  |
| `Access-Control-Allow-Origin` | `*` on all `/v1/*` endpoints (CORS)                                  |

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
const valid = crypto.verify(
  null,
  digest,
  pubKey,
  Buffer.from(data.response_signature, "hex"),
);
```

## Handling Degraded Results

When `degraded: true`, some on-chain checks couldn't complete (RPC timeout, rate limit, etc.).
The `degraded_checks` array tells you which checks failed.

**What it means for risk_score:** Uncertainty penalties are added for each missing check:

- `top_holders`: +10, `liquidity`: +10, `honeypot`: +10, `token_age`: +5, `metadata`: +3
- **Maximum total uncertainty: 38 points** (all checks fail → score starts at 38, risk_level MODERATE)
- A fully-degraded result can never reach CRITICAL or EXTREME from uncertainty alone

The score is conservative by design — it overestimates risk when data is missing.
A token scoring 25 (MODERATE) when degraded might score 15 (LOW) when fully resolved.

**Recommended agent behavior:**

1. If `risk_score <= threshold` despite degradation, still SAFE (penalties make it conservative)
2. If `risk_score > threshold` and degraded, retry after 30s before rejecting
3. For critical decisions, use the full paid endpoint which has longer timeouts

## Caching

Results are cached for 5 minutes. Repeated checks within this window return `X-Cache: HIT` instantly. You still pay per request — the cache saves latency, not cost.

## Webhook Monitoring

Subscribe to risk alerts for specific mints. The server polls watched mints on a background interval and POSTs to your callback URL when `risk_score >= threshold`.

**Authentication:** All webhook endpoints require `Authorization: Bearer <WEBHOOK_ADMIN_BEARER>`.

### Create Subscription

```bash
curl -X POST https://tokensafe-production.up.railway.app/v1/webhooks \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"callback_url": "https://your-server.com/hook", "mints": ["So11111111111111111111111111111111111111112"], "threshold": 50}'
```

Returns 201 with the subscription object, including the full `secret_hmac` (shown only on creation — save it).

### List Subscriptions

```bash
curl https://tokensafe-production.up.railway.app/v1/webhooks \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER"
```

Returns array of subscriptions. Secrets redacted to `***<last 8 chars>`.

### Update Subscription

```bash
curl -X PATCH https://tokensafe-production.up.railway.app/v1/webhooks/1 \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"threshold": 75, "active": false}'
```

### Delete Subscription

```bash
curl -X DELETE https://tokensafe-production.up.railway.app/v1/webhooks/1 \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER"
```

Returns 204 on success.

### Verifying Webhook Deliveries

Each delivery includes an HMAC-SHA256 signature in `X-TokenSafe-Signature`:

```typescript
import crypto from "node:crypto";

function verifyWebhook(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Delivery payload:

```json
{
  "mint": "So11111111111111111111111111111111111111112",
  "risk_score": 75,
  "risk_level": "CRITICAL",
  "summary": "active mint authority, no liquidity detected",
  "checked_at": "2026-03-01T12:00:00.000Z"
}
```

Retry policy: 3 attempts max with exponential backoff (1min, 5min, then abandoned).

## API Key Management

Manage subscription API keys. All endpoints require `Authorization: Bearer <WEBHOOK_ADMIN_BEARER>` (same admin token as webhooks).

### Create API Key

```bash
curl -X POST https://tokensafe-production.up.railway.app/v1/api-keys \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER" \
  -H "Content-Type: application/json" \
  -d '{"label": "my-trading-bot", "tier": "pro"}'
```

Returns 201 with the full API key (shown only once -- save it). Tiers: `pro` (6K checks/month, 200 req/min) or `enterprise` (unlimited, 600 req/min).

Optional `expires_at` field (ISO 8601) sets an expiration date.

### List API Keys

```bash
curl https://tokensafe-production.up.railway.app/v1/api-keys \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER"
```

Returns array of keys with `key_prefix` only (no full key). Includes tier, limits, and active status.

### Get Usage Stats

```bash
curl https://tokensafe-production.up.railway.app/v1/api-keys/1/usage \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER"
```

Returns current month usage count, monthly limit, and usage history.

### Revoke API Key

```bash
curl -X DELETE https://tokensafe-production.up.railway.app/v1/api-keys/1 \
  -H "Authorization: Bearer $WEBHOOK_ADMIN_BEARER"
```

Returns 204 on success. Revoked keys immediately return 401 on use.

### API Key Response Headers

When using an API key, responses include:

| Header                  | Example                    | Description                                              |
| ----------------------- | -------------------------- | -------------------------------------------------------- |
| `X-API-Key-Tier`        | `pro`                      | Subscription tier                                        |
| `X-API-Key-Usage`       | `1234/6000`                | Checks used / monthly limit (`unlimited` for enterprise) |
| `X-API-Key-Usage-Reset` | `2026-04-01T00:00:00.000Z` | When the monthly counter resets                          |
