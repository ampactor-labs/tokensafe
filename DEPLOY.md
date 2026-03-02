# TokenSafe — Deploy & Ship

## Prerequisites

| Requirement | Where to get it |
|---|---|
| **Node.js 22+** and **npm** | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **Helius API key** | Free at [helius.dev](https://helius.dev) → Dashboard → API Keys. 1M credits/month (~6,600 checks/day). |
| **Solana wallet address** | Any base58 Solana address. Phantom → receive → copy address. This is your treasury — it receives USDC payments. |
| **GitHub repo** | Railway deploys from GitHub. Push to `main` before §3. |

**Optional:** [Solana CLI tools](https://solana.com/docs/intro/installation) — not required. Every step in this guide works without them.

---

## 1. Install and Verify

```bash
npm install && npm test && npx tsc --noEmit
```

344 tests pass (73 risk-score + 56 checks + 27 delta + 20 liquidity + 100 integration + 10 webhook + 10 jupiter + 5 response-signer + 18 api-keys + 16 policy-engine + 9 audit-db). Tests mock x402 and RPC — no network or wallet needed.

---

## 2. Local Smoke Test

```bash
cp .env.example .env
```

Edit `.env`:
- `TREASURY_WALLET_ADDRESS` — your Solana wallet address
- `HELIUS_API_KEY` — paste from your Helius dashboard

Leave `SOLANA_NETWORK=devnet` and `NODE_ENV=development`.

Start the server, then smoke test in another terminal:

```bash
npm run dev
```

```bash
npm run test:smoke
```

The smoke test validates all endpoints:

| Check | What it verifies |
|---|---|
| `GET /health` → 200 | Status, version, network, uptime, cache stats |
| Response headers | `X-Response-Time` (ms), `X-RateLimit-Limit/Remaining/Reset` |
| `GET /v1/check/lite` → 200 | Risk score, risk level, summary, full_report upsell, no `checks` (paid-only) |
| `GET /v1/check/lite` bad mint → 400 | `INVALID_MINT_ADDRESS` error |
| `GET /v1/check/lite` no mint → 400 | Missing parameter error |
| `GET /v1/check/lite` enrichment | `can_sell`, `authorities_renounced`, `has_liquidity`, `token_age_hours` fields present |
| `X-Cache` on lite | `HIT` or `MISS` header present |
| `Cache-Control` on lite | `public, max-age=300` present |
| `GET /v1/decide` → 200 | `decision` (SAFE/RISKY/UNKNOWN), `threshold_used`, `risk_score` |
| `GET /v1/decide` threshold | Custom threshold applied correctly |
| `POST /v1/check/batch/small` → 402 | x402 payment gate active on batch routes |
| `GET /v1/check` → 402 | `PAYMENT-REQUIRED` header with x402 payment requirements |
| `score_breakdown` paywall | Present on paid `/v1/check`, absent from `/v1/check/lite` |
| `GET /unknown` → 404 | `NOT_FOUND` structured error |

Exits 0 on pass, 1 on fail.

To smoke-test a deployed instance:

```bash
SMOKE_URL=https://your-railway-domain.up.railway.app npm run test:smoke
```

### Manual spot checks

```bash
curl http://localhost:3000/health
```

```bash
curl -i "http://localhost:3000/v1/check?mint=So11111111111111111111111111111111111111112"
```

Should return 402 with `PAYMENT-REQUIRED` header containing the x402 payment requirements (price, devnet CAIP-2 network, and your treasury wallet).

```bash
curl "http://localhost:3000/v1/check/lite?mint=So11111111111111111111111111111111111111112"
```

Should return 200 with `risk_score`, `risk_level`, `summary`, and `full_report` (upsell to paid endpoint).

### Rate limiting

```bash
seq 65 | xargs -I{} curl -s -o /dev/null -w "{}: %{http_code}\n" "http://localhost:3000/health"
```

Requests 61-65 return `429`. Lite endpoint has a separate, tighter limit (10/min default).

---

## 3. Deploy to Railway

Already deployed once — this is a redeploy with the full feature set.

1. Push to GitHub: `git push origin main`
2. Railway auto-detects the push and redeploys from the Dockerfile.
3. Verify env vars in Settings → Variables:

| Variable | Value | Notes |
|---|---|---|
| `TREASURY_WALLET_ADDRESS` | Your Solana wallet address | Receives USDC payments |
| `HELIUS_API_KEY` | Your Helius key | Free tier: 1M credits/month |
| `SOLANA_NETWORK` | `devnet` | Switch to `mainnet` in §5 |
| `NODE_ENV` | `production` | Omits pino-pretty, runs lean |

Railway injects `PORT` automatically — don't set it. Other optional vars and their defaults:

| Variable | Default | Notes |
|---|---|---|
| `FACILITATOR_URL` | `https://facilitator.payai.network` | PayAI Solana facilitator |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-IP limit for health + paid endpoints |
| `LITE_RATE_LIMIT_PER_MINUTE` | `10` | Per-IP limit for free lite endpoint |
| `WEBHOOK_ADMIN_BEARER` | (unset) | Bearer token for webhook + API key admin routes |
| `PRO_MONTHLY_LIMIT` | `6000` | Monthly check limit for Pro API keys |
| `PRO_RATE_LIMIT` | `200` | Requests/min for Pro API keys |
| `ENTERPRISE_RATE_LIMIT` | `600` | Requests/min for Enterprise API keys |

4. Verify:

```bash
curl https://<your-railway-domain>/health
```

The deploy log will show `bigint: Failed to load bindings, pure JS will be used` — harmless warning from a transitive dependency.

### Fallback: Render

Same Docker deploy, truly free, but 30s cold starts after 15min idle. Fine for testing, too slow for agents.

---

## 4. Test Full x402 Flow (devnet)

End-to-end: test wallet pays USDC → facilitator settles on-chain → server returns analysis.

### 4.1 Generate a test wallet

```bash
npm run wallet:generate
```

Save the `SVM_PRIVATE_KEY` value — you need it for §4.4 and §4.6.

### 4.2 Fund the test wallet

**Devnet SOL** (transaction fees):

Go to [faucet.solana.com](https://faucet.solana.com) → select Devnet → paste the address from §4.1 → request 2 SOL.

**Devnet USDC** (x402 payments):

Go to [faucet.circle.com](https://faucet.circle.com) → select **Solana** → select **Devnet** → paste the address. Deposits devnet USDC (mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).

1 USDC = 1000 checks at testing price ($0.001) or 125 checks at production price ($0.008).

### 4.3 Fund treasury wallet with devnet USDC

Your treasury wallet needs a USDC Associated Token Account on devnet. Without it, the payment transaction fails — no destination account for the USDC transfer.

Go to [faucet.circle.com](https://faucet.circle.com) → **Solana** → **Devnet** → paste your **treasury wallet address**. This auto-creates the ATA and deposits devnet USDC. Even a tiny amount is enough.

### 4.4 Run the test client

Start the server if not already running:

```bash
npm run dev
```

In another terminal:

```bash
SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> npm run test:x402
```

To test a specific mint:

```bash
SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> npx tsx scripts/x402-client.ts EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

The test client tests `GET /v1/check` with multiple tokens.

### 4.5 Expected output

```
→ http://localhost:3000/v1/check?mint=So11111111111111111111111111111111111111112
← 200 OK
   X-Cache: MISS
   X-Response-Time: 1234ms
   Payment receipt: eyJz...
{
  "mint": "So11111111111111111111111111111111111111112",
  "risk_score": 15,
  "risk_level": "LOW",
  "checks": { ... }
}
```

Verify the USDC transfer on [Solana Explorer](https://explorer.solana.com/?cluster=devnet) — search the test wallet address, look for a recent USDC transfer to your treasury wallet.

Run again within 5 minutes — same response but `X-Cache: HIT` (cached; still charges per-request).

### 4.6 Test against Railway

```bash
SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> SMOKE_URL=https://<your-railway-domain> npm run test:x402
```

### 4.7 Checklist

- [ ] Smoke test passes locally (`npm run test:smoke`)
- [ ] 402 response has `PAYMENT-REQUIRED` header
- [ ] `/v1/check` payment amount matches middleware config (testing: 1000/$0.001, production: 8000/$0.008)
- [ ] `payTo` in payment requirements matches `TREASURY_WALLET_ADDRESS`
- [ ] Network = `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet CAIP-2)
- [ ] x402 client gets 200 with full analysis JSON after payment
- [ ] `X-Cache: MISS` first call, `HIT` within 5min
- [ ] `X-Response-Time` header present on all responses
- [ ] USDC arrived in treasury (check Solana Explorer, devnet)
- [ ] Fresh analysis completes in < 2s
- [ ] Smoke test passes against Railway (`SMOKE_URL=... npm run test:smoke`)

---

## 5. Switch to Mainnet

1. Update Railway env vars: set `SOLANA_NETWORK=mainnet`. Railway auto-redeploys.
2. Fund your treasury wallet with a tiny amount of **mainnet** USDC (any amount — the ATA needs to exist). Send from Phantom or any wallet.
3. Re-run smoke test against Railway — verify 402 response shows mainnet CAIP-2 (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) and mainnet USDC mint.
4. Full payment test on mainnet: generate a new wallet (`npm run wallet:generate`), fund with real SOL + real USDC, run `npm run test:x402`. Cost: current middleware price + ~$0.001 tx fee.

---

## 6. Agent Discovery Registrations

Without these, no agent finds you. These are machine-readable registrations — the equivalent of marketing for an API that sells to autonomous agents.

### Endpoints to register

| Endpoint | Method | Price | Auth | Description |
|---|---|---|---|---|
| `/v1/check` | GET | $0.008 USDC | x402 | Full token safety analysis with delta detection |
| `/v1/check/lite` | GET | Free | None (rate-limited) | Risk score + summary + screening fields |
| `/v1/decide` | GET | Free | None (rate-limited) | Binary SAFE/RISKY/UNKNOWN decision |
| `/v1/check/batch/small` | POST | $0.025 USDC | x402 | Batch check up to 5 tokens |
| `/v1/check/batch/medium` | POST | $0.08 USDC | x402 | Batch check up to 20 tokens |
| `/v1/check/batch/large` | POST | $0.15 USDC | x402 | Batch check up to 50 tokens |
| `/v1/audit/small` | POST | $0.08 USDC | x402 or API key | Treasury audit up to 10 tokens |
| `/v1/audit/standard` | POST | $0.30 USDC | x402 or API key | Treasury audit up to 50 tokens |
| `/v1/audit/history` | GET | N/A | API key or Bearer | Audit history |
| `/v1/audit/:id/report` | GET | N/A | API key or Bearer | Compliance report (markdown) |
| `/v1/api-keys` | POST/GET/DELETE | N/A | Bearer auth | API key management (CRUD) |
| `/health` | GET | Free | None | Server status, version, cache stats |

### 6.1 MCP Registries (smithery.ai + mcp.so)

Register MCP tool from `src/mcp/tool-definition.json`:

**`solana_token_safety_check`**
- Free (rate-limited 10/min per IP)
- Returns: risk score, risk level, summary, name, symbol, Token-2022 detection, risky extension flag, full report link
- Keywords in description: safe to trade, rug pull, mint authority, freeze authority, liquidity, honeypot, risk score, Token-2022, delta detection, alerts

The description in `tool-definition.json` is optimized for LLM pattern-matching. The agent's model reads it to decide whether to invoke the tool — specific, concrete terms matter more than marketing language.

**smithery.ai:** [smithery.ai](https://smithery.ai) — submit via their web form or CLI.

**mcp.so:** [mcp.so](https://mcp.so) — official MCP registry. Same tool definitions.

### 6.2 x402.org Ecosystem Page

Submit via GitHub PR to the [x402 Foundation repo](https://github.com/coinbase/x402). Format matches existing listings at [x402.org/ecosystem](https://www.x402.org/ecosystem).

Listing copy:

```
Name: TokenSafe
URL: https://<your-railway-domain>
Description: Cheapest transparent Solana token safety scanner — deterministic on-chain analysis, $0.008/check or free lite tier. Mint/freeze authority, holder concentration, liquidity depth, LP locks, honeypot detection, sell tax estimation, Token-2022 risks. No API keys, no accounts. Pay per request in USDC via x402.
Category: Security / Analytics
Network: Solana
Price: $0.008/check (full), free (lite)
Payment: USDC on Solana via x402
```

### 6.3 PayAI Marketplace

Register at [payai.network](https://payai.network). Already using their facilitator — agents browsing PayAI's marketplace see services listed here.

Listing should include both endpoints with their prices. Emphasize the free lite tier — it's a funnel into the paid endpoint.

### 6.4 x402scan (Merit Systems)

Submit manually at [x402scan](https://x402scan.com) for inclusion. No automatic discovery — manual submission required.

### 6.5 Ecosystem Amplification (Free)

**Post ideas (one is enough, pick the best channel):**

- **dev.to:** "I Built the Cheapest x402 Token Safety Scanner on Solana" — cover the methodology (pure on-chain, no GoPlus proxy), the free tier funnel, and the x402 payment flow. Include code snippets showing how an agent discovers and pays for a check.
- **Solana Stack Exchange:** Answer token safety questions with "here's how to check programmatically" + link. Build authority.
- **Solana x402 Discord/Telegram:** Post in ecosystem channels. The hackathon ended Nov 2025 but the community is active.

**Key differentiators to emphasize everywhere:**

1. **Cheapest:** $0.008/check full, free lite tier. Rug Munch charges $0.02-$2.00.
2. **Transparent:** Every risk point traceable to on-chain state. No opaque ML scoring.
3. **Direct on-chain:** Zero dependency on GoPlus, RugCheck, or any third-party security API.
4. **Free tier:** `/v1/check/lite` gives agents a zero-cost way to screen tokens before paying for the full report.
5. **Built-in delta detection:** Every paid check includes `changes` and `alerts` — what changed since the last check.
6. **No accounts, no API keys:** Payment IS authentication. USDC in, analysis out.

---

## 7. npm Scripts Reference

| Script | Command | What it does |
|---|---|---|
| `npm run dev` | `tsx watch src/index.ts` | Dev server with hot reload + pino-pretty logs |
| `npm run build` | `tsc` | Compile to `dist/` |
| `npm start` | `node dist/index.js` | Production server |
| `npm test` | `vitest run` | 344 tests (mocked, no network) |
| `npm run test:smoke` | `tsx scripts/smoke.ts` | Smoke test against running server |
| `npm run test:x402` | `tsx scripts/x402-client.ts` | x402 paid request test |
| `npm run wallet:generate` | `tsx scripts/generate-test-wallet.ts` | Generate Solana test keypair |

Override target URL for smoke and x402 tests: `SMOKE_URL=https://... npm run test:smoke`

---

## Troubleshooting

**402 response empty or malformed:** `TREASURY_WALLET_ADDRESS` must be a valid base58 Solana address. Check `.env`.

**"Transaction simulation failed":** Test wallet has no SOL (can't pay tx fees) or no USDC. Re-do §4.2.

**"Account not found":** Treasury wallet has no USDC ATA on devnet. Re-do §4.3.

**"Payment verification failed at facilitator":** PayAI facilitator may not support devnet. Try Coinbase: set `FACILITATOR_URL=https://x402.org/facilitator` in `.env` and restart.

**"Blockhash expired":** Facilitator was too slow to settle. Transient — retry.

**"No matching scheme":** Client couldn't match the server's network identifier. Ensure `SOLANA_NETWORK=devnet` in `.env`.

**ECONNREFUSED:** Server not running. Start with `npm run dev`.

**400 Bad Request:** Invalid or missing `mint` query parameter. Must be a valid base58 Solana token mint address.

**429 Too Many Requests:** Hit rate limit. Default: 60/min for paid endpoints, 10/min for lite. Adjust via `RATE_LIMIT_PER_MINUTE` and `LITE_RATE_LIMIT_PER_MINUTE` env vars.

**503 Service Unavailable:** Helius RPC unreachable. Verify key: `curl "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"`. Free tier = 10 RPS, 1M credits/month.

**Railway deploy fails:** Check build logs. Usually TypeScript errors — run `npx tsc --noEmit` locally first.

**Cache not working:** Hit same mint twice within 5min. First: `X-Cache: MISS`. Second: `X-Cache: HIT`. Check `/health` for `cache.size`.

**`bigint: Failed to load bindings`:** Harmless warning in Docker. Native BigInt addon not available; pure JS fallback works identically.
