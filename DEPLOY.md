# TokenSafe — Deploy & Test

## Prerequisites

1. **Solana wallet** — base58 public address (Phantom → SOL → copy). Receives USDC payments.
2. **Helius API key** — free at [helius.dev](https://helius.dev). 1M credits/month (~6,600 checks/day).
3. **GitHub repo** — Railway deploys from GitHub.

## 1. Automated Tests

```bash
npm test
```

Runs 27 tests: 16 risk-score unit tests + 11 integration tests (health, /v1/check, error handling, cache headers, 404). Integration tests mock x402 middleware and RPC calls — no network access needed.

## 2. Local Smoke Test

```bash
cp .env.example .env
```

Edit `.env` — set `TREASURY_WALLET_ADDRESS` and `HELIUS_API_KEY`. Leave `SOLANA_NETWORK=devnet`.

```bash
npm run dev
```

In another terminal:

```bash
npm run test:smoke
```

Validates: health endpoint, 402 gate with `PAYMENT-REQUIRED` header, 404 handling, `X-Response-Time` and `X-RateLimit` headers. Exits 0 on success, 1 on failure.

To run against a deployed instance:

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

Should return 402 with `PAYMENT-REQUIRED` header containing price ($0.005 USDC), network (devnet CAIP-2), and your treasury wallet.

### Rate limiting

```bash
seq 65 | xargs -I{} curl -s -o /dev/null -w "{}: %{http_code}\n" "http://localhost:3000/health"
```

Requests 61-65 should return `429`.

```bash
curl -sI http://localhost:3000/health | grep -i x-ratelimit
```

## 3. Deploy to Railway

1. Sign in at [railway.app](https://railway.app) with GitHub.
2. New Project → Deploy from GitHub repo → select `tokensafe`.
3. Set env vars in Settings → Variables:

| Variable | Value |
|----------|-------|
| `TREASURY_WALLET_ADDRESS` | Your Solana wallet address |
| `HELIUS_API_KEY` | Your Helius key |
| `SOLANA_NETWORK` | `devnet` |
| `NODE_ENV` | `production` |

Railway injects `PORT` automatically — don't set it manually. `FACILITATOR_URL` and `RATE_LIMIT_PER_MINUTE` have sensible defaults, leave unset unless you need to override.

4. Settings → Networking → Generate Domain.
5. Verify:

```bash
curl https://<your-railway-domain>/health
```

### Fallback: Render

Same Docker deploy, truly free, but 30s cold starts after 15min idle. Fine for testing, too slow for agents.

## 4. Test Full x402 Flow (devnet)

Requires devnet SOL ([faucet.solana.com](https://faucet.solana.com)) + devnet USDC (mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) + an x402-compatible client.

The Solana Foundation [x402 tutorial](https://solana.com/developers/guides/getstarted/intro-to-x402) has a client example. Flow: GET → 402 → sign USDC transfer → retry with `PAYMENT-SIGNATURE` → facilitator settles → 200 with data.

### Checklist

- [ ] 402 includes `PAYMENT-REQUIRED` header
- [ ] Payment amount = 5000 ($0.005 USDC)
- [ ] `payTo` matches treasury wallet
- [ ] Correct devnet CAIP-2 network identifier
- [ ] 200 response contains full analysis JSON after payment
- [ ] `X-Cache: MISS` first call, `HIT` within 5min
- [ ] `X-Response-Time` header present
- [ ] USDC lands in treasury (check Solana Explorer, devnet)
- [ ] Fresh analysis < 2s

## 5. Switch to Mainnet

Update Railway env: `SOLANA_NETWORK=mainnet`. Auto-redeploys. Test with real USDC ($0.005/req, net cost ~$0.001 tx fee).

## 6. Agent Discovery Registrations

Without these, no agent finds you.

1. **smithery.ai** — register MCP tool using `src/mcp/tool-definition.json`
2. **mcp.so** — same tool definition, official MCP registry
3. **x402.org/ecosystem** — submit PR to x402 Foundation repo (name, URL, price, category: Security/Analytics)
4. **payai.network** — list on PayAI marketplace (already using their facilitator)
5. **x402scan** — submit manually to Merit Systems explorer

## Troubleshooting

**402 response empty/malformed:** `TREASURY_WALLET_ADDRESS` must be valid base58 Solana address.

**RPC errors (503):** Helius key invalid or rate-limited. Verify: `curl "https://devnet.helius-rpc.com/?api-key=YOUR_KEY"`. Free tier = 10 RPS.

**Payment fails at facilitator:** Confirm `FACILITATOR_URL` is `https://facilitator.payai.network`. No v1 fallback if PayAI is down.

**Railway deploy fails:** Check build logs. Usually TypeScript errors — run `npx tsc --noEmit` locally first.

**Cache not working:** Hit same mint twice within 5min. First: `X-Cache: MISS`. Second: `X-Cache: HIT`. Check `/health` for `cache.size`.

**Rate limiter too aggressive:** Set `RATE_LIMIT_PER_MINUTE=300` in Railway env vars.
