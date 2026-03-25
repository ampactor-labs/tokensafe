# TokenSafe

Solana token safety scanner. Deterministic on-chain analysis behind x402 micropayments.

**$0.008/request in USDC. No API keys. No accounts. No opaque ML. Payment IS authentication.**

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

Risk score 0-100 where every point is traceable to on-chain state. No third-party security APIs.

## Quick Start

### Free lite check (no payment needed)

```bash
curl https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112
```

Returns risk score, risk level, and summary. Rate-limited to 30/min per IP.

### Full paid check (x402)

```bash
# First request returns 402 with payment requirements
curl -s https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112

# Use any x402-compatible client to handle payment automatically
```

Any x402-compatible wallet/client handles the payment flow automatically. $0.008 USDC per request.

### MCP (Claude Code, Cursor, Windsurf)

```bash
# Claude Code plugin (recommended)
/plugin marketplace add ampactor-labs/tokensafe
/plugin install tokensafe@ampactor-labs

# Or direct MCP server add
claude mcp add tokensafe --transport http https://tokensafe-production.up.railway.app/mcp
```

One tool: `solana_token_safety_check` — free risk score, summary, and Token-2022 detection. Full report via x402 REST API.

### Discovery

```bash
curl https://tokensafe-production.up.railway.app/.well-known/x402
```

Machine-readable service description for automated agent discovery.

## Endpoints

| Endpoint                                 | Price       | Auth | Rate Limit |
| ---------------------------------------- | ----------- | ---- | ---------- |
| `GET /v1/check?mint=<ADDR>`              | $0.008 USDC | x402 | 60/min/IP  |
| `GET /v1/check/lite?mint=<ADDR>`         | Free        | None | 30/min/IP  |
| `GET /v1/decide?mint=<ADDR>&threshold=N` | Free        | None | 30/min/IP  |
| `GET /health`                            | Free        | None | 60/min/IP  |
| `POST /mcp`                              | Free        | None | 30/min/IP  |
| `GET /.well-known/x402`                  | Free        | None | —          |

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
    "price_usd": "$0.008",
    "payment_protocol": "x402",
    "includes": "authority addresses, holder breakdown, LP lock status, honeypot details, delta detection"
  }
}
```

## x402 Payment Flow

```
Agent  →  GET /v1/check?mint=<TOKEN>
Server →  402 + PAYMENT-REQUIRED header (base64 JSON)
Agent  →  wallet auto-signs $0.008 USDC transfer
Agent  →  GET /v1/check?mint=<TOKEN> + PAYMENT-SIGNATURE header
Server →  200 + full analysis + PAYMENT-RESPONSE receipt
```

USDC settles to the operator's Solana wallet in ~400ms via the PayAI facilitator.

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

## License

MIT
