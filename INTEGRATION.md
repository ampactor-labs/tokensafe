# TokenSafe Integration Guide

**Audience:** AI agents and the LLMs that build integrations for them.

## Quick Start (5 lines)

```typescript
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { toClientSvmSigner } from "@x402/svm";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const client = new x402Client();
registerExactSvmScheme(client, { signer: toClientSvmSigner(yourKeypair) });
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch("https://tokensafe.example.com/v1/check?mint=TOKEN_MINT");
const data = await res.json();
// data.risk_score, data.risk_level, data.checks, etc.
```

## How Payment Works

TokenSafe uses the x402 protocol. No API keys, no accounts. Payment is authentication.

1. Agent sends `GET /v1/check?mint=<MINT>` with no auth headers
2. Server returns `402 Payment Required` with `PAYMENT-REQUIRED` header containing payment details
3. Agent's x402 client automatically signs a USDC transfer for the requested price
4. Agent retries the request with `PAYMENT-SIGNATURE` header
5. Facilitator verifies and settles on-chain (~400ms)
6. Server returns `200 OK` with token safety data

The `@x402/fetch` package handles steps 2-4 automatically — your code just calls `paidFetch(url)`.

## Wallet Setup

You need a Solana wallet with USDC for payments.

```bash
npm install @solana/kit @scure/base @x402/fetch @x402/svm
```

```typescript
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

// Load from environment (base58-encoded 64-byte keypair)
const keypairBytes = base58.decode(process.env.SVM_PRIVATE_KEY);
const keypair = await createKeyPairSignerFromBytes(keypairBytes);
```

Fund the wallet with USDC on Solana mainnet. Each check costs $0.008 USDC (8000 raw units, USDC has 6 decimals).

## Endpoints

### `GET /v1/check?mint=<MINT>` — Full Safety Analysis ($0.008)

Returns comprehensive risk assessment for a single Solana token.

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `mint` | string | Token mint address |
| `name` | string \| null | Token name from metadata |
| `symbol` | string \| null | Token symbol |
| `checked_at` | string | ISO 8601 timestamp |
| `risk_score` | number | 0-100 (0 = safest) |
| `risk_level` | string | LOW / MODERATE / HIGH / CRITICAL / EXTREME |
| `risk_factors` | string[] | Human-readable list of detected risks |
| `summary` | string | Comma-separated risk factors or "No risk factors detected" |
| `degraded` | boolean | True if any check was unavailable |
| `rpc_slot` | number | Solana slot number at time of analysis |
| `methodology_version` | string | Scoring algorithm version (currently "1.0.0") |
| `response_signature` | string | Ed25519 signature over `{mint, checked_at, rpc_slot, risk_score}` |
| `signer_pubkey` | string | Hex-encoded public key for signature verification |
| `checks` | object | Detailed per-check results (see below) |

**Checks object:**

| Check | Key fields |
|-------|------------|
| `mint_authority` | `status` (RENOUNCED/ACTIVE), `authority`, `risk` |
| `freeze_authority` | `status` (RENOUNCED/ACTIVE), `authority`, `risk` |
| `supply` | `total`, `decimals` |
| `top_holders` | `top_10_percentage`, `top_1_percentage`, `top_holders_detail`, `holder_count_estimate` |
| `liquidity` | `has_liquidity`, `primary_pool`, `price_impact_pct`, `liquidity_rating`, `lp_locked`, `lp_mint`, `lp_locker` |
| `metadata` | `mutable`, `update_authority`, `has_uri`, `uri` |
| `honeypot` | `can_sell`, `sell_tax_bps`, `risk` |
| `token_age_hours` | Hours since creation (null if unknown) |
| `token_age_minutes` | Minutes since creation (null if unknown) |
| `token_program` | SPL Token or Token-2022 program address |
| `is_token_2022` | Whether token uses Token-2022 |
| `token_2022_extensions` | Array of extension details (TransferFee, PermanentDelegate, TransferHook, etc.) |

### `GET /v1/check/lite?mint=<MINT>` — Quick Screening (Free)

Rate-limited to 10/min per IP. Returns `mint`, `name`, `symbol`, `risk_score`, `risk_level`, `summary`, `degraded`, `is_token_2022`, `has_risky_extensions`, and `full_report` (upsell to paid endpoint).

### `GET /v1/batch?mints=<MINT1>,<MINT2>,...` — Batch Check ($0.04)

Check up to 10 tokens at once. 50% discount at max 10 tokens vs individual checks.

**Response:**

```json
{
  "checked_at": "2026-02-27T12:00:00Z",
  "token_count": 3,
  "results": [ /* array of full check results */ ],
  "errors": [ /* { mint, error: { code, message } } for failed tokens */ ]
}
```

### `GET /v1/monitor?mints=<MINT1>,<MINT2>,...` — Portfolio Monitor ($0.008)

Same as batch but includes delta detection — what changed since last check. Returns alerts for critical changes (authority activations, liquidity removals, score jumps).

### `GET /health` — Server Status (Free)

Returns server status, version, uptime, cache stats, signer public key for response verification, and available API versions.

## Risk Score Interpretation

| Score | Level | Action |
|-------|-------|--------|
| 0-20 | LOW | Safe to interact |
| 21-40 | MODERATE | Proceed with caution |
| 41-60 | HIGH | Significant risk — review `risk_factors` |
| 61-80 | CRITICAL | Do not trade |
| 81-100 | EXTREME | Confirmed scam/honeypot |

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `INVALID_MINT_ADDRESS` | 400 | Bad or missing mint address |
| `TOKEN_NOT_FOUND` | 404 | Mint account doesn't exist on chain |
| `TOO_MANY_MINTS` | 400 | Batch/monitor exceeds 10 mint limit |
| `RPC_ERROR` | 503 | Solana RPC unavailable — retry later |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests — check `X-RateLimit-Reset` header |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

All errors return structured JSON: `{ "error": { "code": "...", "message": "..." } }`

## Response Headers

| Header | Description |
|--------|-------------|
| `X-Cache` | HIT (cached) or MISS (fresh analysis) |
| `X-Response-Time` | Server processing time in ms |
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

## MCP Tool Usage

TokenSafe is registered as an MCP tool. When an agent's LLM sees a task like "check if this token is safe" or "analyze this Solana token for rug risk", it should invoke:

```json
{
  "name": "solana_token_safety_check",
  "arguments": { "mint_address": "TOKEN_MINT_ADDRESS" }
}
```

Batch checking:
```json
{
  "name": "solana_token_batch_check",
  "arguments": { "mint_addresses": "MINT1,MINT2,MINT3" }
}
```

## Caching

Results are cached for 5 minutes. Repeated checks within this window return `X-Cache: HIT` instantly. You still pay per request — the cache saves latency, not cost.
