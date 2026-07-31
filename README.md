# TokenSafe

Solana token safety scanner. Deterministic on-chain analysis, cryptographically signed, behind x402 micropayments.

**Status: shipping.** Live on mainnet behind x402 micropayments. No CI workflows in this repo; the deploy is Railway-side.

**$0.02/request in USDC. No API keys, no accounts, no opaque ML.** Every verdict is read straight from chain state and Ed25519-signed — so anyone can verify TokenSafe said it, at [`/v1/verify`](#verifiable-attestations). Aggregators reselling third-party grades can't do that. Payment is authentication.

**Try it:** [scry.app](https://scry-production.up.railway.app/) (web) · [@ScryTokenBot](https://t.me/ScryTokenBot) (Telegram)

## What It Checks

| Check            | What It Detects                          | Source                         |
| ---------------- | ---------------------------------------- | ------------------------------ |
| Mint authority   | Supply inflation risk                    | RPC `getAccountInfo`           |
| Freeze authority | Token seizure risk                       | RPC `getAccountInfo`           |
| Top holders      | Concentration / rug risk                 | RPC `getTokenLargestAccounts`  |
| Liquidity        | Sellability, price impact                | Jupiter quote API              |
| LP locks         | Liquidity removal risk                   | RPC + 9 known locker programs  |
| Honeypot         | Can't-sell detection                     | Jupiter buy/sell comparison    |
| Metadata         | Name/image bait-and-switch               | RPC Metaplex PDA               |
| Token age        | Fresh launch signal                      | RPC `getSignaturesForAddress`  |
| Token-2022       | Transfer fees, permanent delegate, hooks | TLV extension parsing          |

Rug risk score 0-100 where every point is traceable to on-chain state. No third-party security APIs.

## Quick Start

### Free lite check (no payment needed)

```bash
curl https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112
```

Returns rug risk score, risk level, and summary. Rate-limited to 30/min per IP.

### Full paid check (x402)

```bash
# First request returns 402 with payment requirements
curl -s https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112

# Use any x402-compatible client to handle payment automatically
```

Any x402-compatible wallet/client handles the payment flow automatically. $0.02 USDC per request.

### MCP (Claude Code, Cursor, Windsurf)

```bash
# Claude Code plugin (recommended)
/plugin marketplace add ampactor-labs/tokensafe
/plugin install tokensafe@ampactor-labs

# Or direct MCP server add
claude mcp add tokensafe --transport http https://tokensafe-production.up.railway.app/mcp
```

One tool: `solana_token_safety_check` — free rug risk score, summary, and Token-2022 detection. Full report via x402 REST API.

### Discovery

Machine-readable service descriptions for automated agent + aggregator discovery:

```bash
curl https://tokensafe-production.up.railway.app/openapi.json          # OpenAPI 3.1 (x-x402 per paid op)
curl https://tokensafe-production.up.railway.app/.well-known/x402      # x402 manifest (x402scan compat)
curl https://tokensafe-production.up.railway.app/discovery/resources   # x402 Bazaar resource list
curl https://tokensafe-production.up.railway.app/llms.txt              # agent guide (markdown)
```

All discovery documents are generated from a single source of truth
(`src/discovery/catalog.ts`), so advertised prices can never drift from the
prices the x402 payment gate actually charges.

## Endpoints

| Endpoint                                 | Price       | Auth | Rate Limit |
| ---------------------------------------- | ----------- | ---- | ---------- |
| `GET /v1/check?mint=<ADDR>`              | $0.02 USDC  | x402 | 60/min/IP  |
| `POST /v1/check/batch/{small,medium,large}` | $0.07 / $0.20 / $0.40 | x402 | 60/min/IP |
| `POST /v1/audit/{small,standard}`        | $0.15 / $0.60 | x402 | 60/min/IP |
| `POST /v1/subscribe`                     | $49 USDC    | x402 | 60/min/IP  |
| `GET /v1/check/lite?mint=<ADDR>`         | Free        | None | 30/min/IP  |
| `GET /v1/decide?mint=<ADDR>&threshold=N` | Free        | None | 30/min/IP  |
| `POST /v1/verify`                        | Free        | None | 60/min/IP  |
| `GET /health`                            | Free        | None | 60/min/IP  |
| `POST /mcp`                              | Free        | None | 30/min/IP  |
| `GET /.well-known/x402`                  | Free        | None | —          |
| `GET /openapi.json`                      | Free        | None | —          |
| `GET /discovery/resources`              | Free        | None | —          |
| `GET /llms.txt`                          | Free        | None | —          |

`POST /v1/subscribe` pays once via x402 and returns a 30-day Pro API key
(6000 checks/mo, 200 req/min) — send it as `X-API-Key` to skip per-call payment.

## Response (Full Check)

```json
{
  "mint": "So11111111111111111111111111111111111111112",
  "name": "Wrapped SOL",
  "symbol": "SOL",
  "risk_score": 5,
  "risk_level": "LOW",
  "summary": "Low risk. Mint/freeze authorities active but deeply liquid with distributed holders.",
  "checks": {
    "mint_authority": {
      "status": "ACTIVE",
      "authority": "...",
      "risk": "SAFE"
    },
    "freeze_authority": {
      "status": "RENOUNCED",
      "authority": null,
      "risk": "SAFE"
    },
    "top_holders": { "top_10_percentage": 12.5, "risk": "SAFE" },
    "liquidity": {
      "liquidity_rating": "DEEP",
      "lp_locked": true,
      "risk": "SAFE"
    },
    "honeypot": { "can_sell": true, "risk": "SAFE" },
    "metadata": { "mutable": false, "risk": "SAFE" },
    "token_age_hours": 8760
  },
  "changes": null,
  "alerts": []
}
```

Delta detection is automatic — `changes` and `alerts` populate when a token's state differs from its previous check.

## Response (Lite Check)

```json
{
  "mint": "So11111111111111111111111111111111111111112",
  "name": "Wrapped SOL",
  "symbol": "SOL",
  "risk_score": 5,
  "risk_level": "LOW",
  "summary": "Low risk. ...",
  "authorities_renounced": true,
  "trusted_authority": false,
  "has_liquidity": true,
  "can_sell": true,
  "data_confidence": "complete",
  "is_token_2022": false,
  "has_risky_extensions": false,
  "full_report": {
    "url": "https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112",
    "price_usd": "$0.02",
    "payment_protocol": "x402",
    "includes": "authority addresses, holder breakdown, LP lock status, honeypot details, delta detection"
  }
}
```

## x402 Payment Flow

```
Agent  →  GET /v1/check?mint=<TOKEN>
Server →  402 + PAYMENT-REQUIRED header (base64 JSON)
Agent  →  wallet auto-signs $0.02 USDC transfer
Agent  →  GET /v1/check?mint=<TOKEN> + PAYMENT-SIGNATURE header
Server →  200 + full analysis + PAYMENT-RESPONSE receipt
```

USDC settles to the operator's Solana wallet via the Coinbase CDP facilitator
(configurable with `FACILITATOR_URL`).

## Verifiable attestations

Every full check is Ed25519-signed over `{mint, checked_at, rpc_slot, risk_score}`.
The response carries `response_signature` and `signer_pubkey` (also exposed at
`/health`). Anyone can confirm the verdict is genuine — no need to trust whoever
forwarded it:

```bash
curl -s -X POST https://tokensafe-production.up.railway.app/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{"mint":"<MINT>","checked_at":"<ISO>","rpc_slot":<N>,"risk_score":<N>,"response_signature":"<hex>"}'
# → { "valid": true, "signer_pubkey": "<hex>" }
```

Because the score is computed from raw chain state (not resold from a
third-party API), the signature is a real proof of provenance — a treasury or
compliance agent can store it as auditable proof-of-diligence. Operators should
set a persistent `RESPONSE_SIGNING_KEY` (`npm run signing-key:generate`) so
attestations stay verifiable across deploys.

## Self-Hosting

```bash
git clone https://github.com/ampactor-labs/tokensafe
cd tokensafe
cp .env.example .env
# Set TREASURY_WALLET_ADDRESS and HELIUS_API_KEY in .env
npm install
npm run dev
```

Requires: Node 22+, a Solana wallet, and a free [Helius](https://helius.dev) API key.

## Architecture

TypeScript + Express. Every check reads raw Solana blockchain state via Helius RPC. No GoPlus, no RugCheck, no off-chain databases, no ML models.

- 6-9 RPC calls + 1-2 HTTP calls per check
- 5-minute in-memory LRU cache (10K entries)
- Ed25519 response signing for audit trail
- Docker-ready (node:22-slim, non-root user)

## Weak spots

This reads chain state, so it can only catch what chain state shows. A developer who simply sells, an off-chain social rug, or a compromised team wallet all produce a clean report right up until they do not. A SAFE verdict means the checks below found nothing, not that the token is safe.

Honeypot detection compares a Jupiter buy quote with a sell quote, which misses conditional logic that only refuses some sellers or only after some time. LP-lock detection recognizes nine known locker programs, so liquidity locked in an unrecognized contract reads as unlocked and scores worse than it deserves.

No CI runs in this repo. The signing key, the treasury address, and the deploy live in Railway, so the receipts here are the signed response and the on-chain payment, not a green badge.

## License

MIT
