# TokenSafe — Deploy & Test

## Prerequisites

| Requirement | Where to get it |
|---|---|
| **Node.js 22+** and **npm** | [nodejs.org](https://nodejs.org) or `nvm install 22` |
| **Helius API key** | Free at [helius.dev](https://helius.dev) → Dashboard → API Keys. 1M credits/month (~6,600 checks/day). |
| **Solana wallet address** | Any base58 Solana address. Phantom → receive → copy address. This is your treasury — it receives USDC payments. |
| **GitHub repo** | Railway deploys from GitHub. Push the repo before §3. |

**Optional:** [Solana CLI tools](https://solana.com/docs/intro/installation) — not required. Every step in this guide works without them. Install only if you prefer CLI over web faucets:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

## 1. Install and Verify

```bash
npm install && npm test && npx tsc --noEmit
```

27 tests pass (16 risk-score unit + 11 integration). Integration tests mock x402 and RPC — no network needed.

## 2. Local Smoke Test

```bash
cp .env.example .env
```

Edit `.env`:
- `TREASURY_WALLET_ADDRESS` — your Solana wallet address (any valid base58 address)
- `HELIUS_API_KEY` — paste the key from your Helius dashboard

Leave `SOLANA_NETWORK=devnet` and `NODE_ENV=development`.

Start the server:

```bash
npm run dev
```

In another terminal:

```bash
npm run test:smoke
```

Validates: health endpoint (200, version, network, uptime, cache size), x402 gate (402 + `PAYMENT-REQUIRED` header), 404 handling, `X-Response-Time` and `X-RateLimit-*` headers. Exits 0 on pass, 1 on fail.

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

Should return 402 with `PAYMENT-REQUIRED` header containing price ($0.015 USDC), devnet CAIP-2 network, and your treasury wallet.

### Rate limiting

```bash
seq 65 | xargs -I{} curl -s -o /dev/null -w "{}: %{http_code}\n" "http://localhost:3000/health"
```

Requests 61-65 return `429`. Inspect headers:

```bash
curl -sI http://localhost:3000/health | grep -i x-ratelimit
```

## 3. Deploy to Railway

1. Sign in at [railway.app](https://railway.app) with GitHub.
2. New Project → Deploy from GitHub repo → select `tokensafe`.
3. Railway auto-detects the Dockerfile — no build command config needed.
4. Set env vars in Settings → Variables:

| Variable | Value |
|---|---|
| `TREASURY_WALLET_ADDRESS` | Your Solana wallet address |
| `HELIUS_API_KEY` | Your Helius key |
| `SOLANA_NETWORK` | `devnet` |
| `NODE_ENV` | `production` |

Railway injects `PORT` automatically — don't set it. `FACILITATOR_URL` and `RATE_LIMIT_PER_MINUTE` have sensible defaults; leave unset unless you need to override.

5. Settings → Networking → Generate Domain.
6. Verify:

```bash
curl https://<your-railway-domain>/health
```

The deploy log will show `bigint: Failed to load bindings, pure JS will be used` — this is a harmless warning from a transitive dependency. The server runs fine on the pure JS fallback.

### Fallback: Render

Same Docker deploy, truly free, but 30s cold starts after 15min idle. Fine for testing, too slow for agents.

## 4. Test Full x402 Flow (devnet)

End-to-end test: test wallet pays $0.015 devnet USDC → facilitator settles on-chain → server returns token analysis. The `scripts/x402-client.ts` script handles the full 402→sign→retry flow automatically.

### 4.1 Generate a test wallet

```bash
npm run wallet:generate
```

Output:

```
Address:         <YOUR_TEST_ADDRESS>
SVM_PRIVATE_KEY: <YOUR_BASE58_KEYPAIR>

Next steps:
  1. Fund with devnet SOL:  https://faucet.solana.com
  2. Fund with devnet USDC: https://faucet.circle.com
  3. Run the test client:
     SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> npm run test:x402
```

Save the `SVM_PRIVATE_KEY` value — you'll need it for §4.4 and §4.6. The address is what you paste into faucets below.

### 4.2 Fund the test wallet

**Devnet SOL** (needed for transaction fees):

Go to [faucet.solana.com](https://faucet.solana.com) → select Devnet → paste the address from §4.1 → request 2 SOL.

Or, if you have the Solana CLI installed:

```bash
solana airdrop 2 <YOUR_TEST_ADDRESS> --url devnet
```

**Devnet USDC** (needed for x402 payments):

Go to [faucet.circle.com](https://faucet.circle.com) → select **Solana** → select **Devnet** → paste the address from §4.1. This deposits devnet USDC (mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). 1 USDC = ~66 test runs at $0.015 each.

### 4.3 Fund treasury wallet with devnet USDC

Your treasury wallet (`TREASURY_WALLET_ADDRESS` in `.env`) must have a USDC Associated Token Account on devnet. Without it, the payment transaction fails because there's no destination account for the USDC transfer.

Go to [faucet.circle.com](https://faucet.circle.com) → select **Solana** → select **Devnet** → paste your **treasury wallet address**. This auto-creates the ATA and deposits devnet USDC. Even a tiny amount is enough — the ATA just needs to exist.

### 4.4 Run the test client

Start the server (if not already running):

```bash
npm run dev
```

In another terminal:

```bash
SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> npm run test:x402
```

Replace `<YOUR_BASE58_KEYPAIR>` with the value from §4.1.

To test a different mint address:

```bash
SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> npx tsx scripts/x402-client.ts EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

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
  ...
}
```

Verify the USDC transfer on [Solana Explorer](https://explorer.solana.com/?cluster=devnet) — search the test wallet address, look for a recent USDC transfer to your treasury wallet.

Run again within 5 minutes — same response but `X-Cache: HIT` (cached result; still charges per-request).

### 4.6 Test against Railway

```bash
SVM_PRIVATE_KEY=<YOUR_BASE58_KEYPAIR> SMOKE_URL=https://tokensafe-production.up.railway.app npm run test:x402
```

### 4.7 Checklist

- [ ] Smoke test passes locally (`npm run test:smoke`)
- [ ] 402 response has `PAYMENT-REQUIRED` header
- [ ] Payment amount = 15000 ($0.015 USDC, 6 decimals)
- [ ] `payTo` in payment requirements matches `TREASURY_WALLET_ADDRESS`
- [ ] Network = `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet CAIP-2)
- [ ] x402 client gets 200 with full analysis JSON after payment
- [ ] `X-Cache: MISS` first call, `HIT` within 5min
- [ ] `X-Response-Time` header present on all responses
- [ ] USDC arrived in treasury (check Solana Explorer, devnet)
- [ ] Fresh analysis completes in < 2s
- [ ] Smoke test passes against Railway (`SMOKE_URL=... npm run test:smoke`)

### 4.8 Troubleshooting

**"Transaction simulation failed"** — Test wallet has no SOL (can't pay tx fees) or no USDC. Re-do §4.2.

**"Account not found"** — Treasury wallet has no USDC ATA on devnet. Re-do §4.3.

**"Payment verification failed at facilitator"** — PayAI facilitator may not support devnet. Switch to Coinbase facilitator: set `FACILITATOR_URL=https://x402.org/facilitator` in `.env` and restart the server.

**"Blockhash expired"** — Facilitator was too slow to settle. Transient — retry.

**"No matching scheme"** — The client couldn't match the server's network identifier. Ensure server `.env` has `SOLANA_NETWORK=devnet`.

**ECONNREFUSED** — Server not running. Start with `npm run dev`.

**400 Bad Request** — Invalid or missing `mint` query parameter. Must be a valid base58 Solana token mint address.

**503 Service Unavailable** — Helius RPC unreachable. Check your `HELIUS_API_KEY` is valid: `curl "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"`.

## 5. Switch to Mainnet

1. Update Railway env vars: set `SOLANA_NETWORK=mainnet`. Railway auto-redeploys.
2. Fund your treasury wallet with a tiny amount of **mainnet** USDC (any amount — the ATA needs to exist). Send from Phantom or any wallet.
3. Re-run the smoke test against Railway to verify the 402 response now shows the mainnet CAIP-2 network (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) and the mainnet USDC mint.
4. To test the full payment flow on mainnet, generate a new wallet (`npm run wallet:generate`), fund it with real SOL + real USDC, and run `npm run test:x402`. Cost: $0.015 USDC + ~$0.001 tx fee.

## 6. Agent Discovery Registrations

Without these, no agent finds you. These are the "marketing" — machine-readable registration, not human marketing.

1. **smithery.ai** — register MCP tool using `src/mcp/tool-definition.json`
2. **mcp.so** — same tool definition, official MCP registry
3. **x402.org/ecosystem** — submit PR to x402 Foundation repo (name, URL, price, category: Security/Analytics)
4. **payai.network** — list on PayAI marketplace (already using their facilitator)
5. **x402scan** — submit manually to Merit Systems explorer

## Troubleshooting

**402 response empty or malformed:** `TREASURY_WALLET_ADDRESS` must be a valid base58 Solana address. Check `.env`.

**RPC errors (503):** Helius key invalid or rate-limited. Verify: `curl "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"`. Free tier = 10 RPS, 1M credits/month.

**Payment fails at facilitator:** Confirm `FACILITATOR_URL`. Default is `https://facilitator.payai.network`. If PayAI is down, try `https://x402.org/facilitator`.

**Railway deploy fails:** Check build logs. Usually TypeScript errors — run `npx tsc --noEmit` locally first.

**Cache not working:** Hit same mint twice within 5min. First: `X-Cache: MISS`. Second: `X-Cache: HIT`. Check `/health` response for `cache.size`.

**Rate limiter too aggressive:** Set `RATE_LIMIT_PER_MINUTE=300` in Railway env vars.

**`bigint: Failed to load bindings`** — Harmless warning in Docker. Native BigInt addon not available; pure JS fallback works identically. No action needed.
