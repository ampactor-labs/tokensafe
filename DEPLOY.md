# TokenSafe — Deploy & Test Walkthrough

Everything you need to go from local code to live x402 service. Start on devnet, verify the full payment flow, then flip to mainnet.

---

## Prerequisites

You need three things before starting:

1. **A Solana wallet** — any wallet works (Phantom, Solflare, CLI). This wallet receives USDC payments. You'll need its **base58 public address** (not private key).

2. **Helius API key** — free at [helius.dev](https://helius.dev). Sign up, create a project, copy the API key. Free tier gives 1M credits/month (~33K requests/day, ~6,600 token checks/day).

3. **A GitHub repo** — Railway deploys from GitHub. If you haven't pushed yet:
   ```bash
   git init && git add -A && git commit -m "Initial commit"
   gh repo create tokensafe --private --push
   ```

---

## Part 1: Local Smoke Test

Before deploying anywhere, verify the server starts and responds locally.

```bash
# Create .env from the example
cp .env.example .env
```

Edit `.env` and fill in:
```
TREASURY_WALLET_ADDRESS=<your-solana-wallet-address>
HELIUS_API_KEY=<your-helius-key>
SOLANA_NETWORK=devnet
NODE_ENV=development
```

Start the server:
```bash
npm run dev
```

Test the health endpoint (free, no payment):
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "network": "devnet",
  "uptime": 3,
  "cache": { "size": 0, "maxSize": 10000 }
}
```

Test that `/v1/check` returns a 402 (payment required):
```bash
curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/v1/check?mint=So11111111111111111111111111111111111111112"
```

Should print `402`. That's correct — the x402 middleware is gating the endpoint. Without a valid `PAYMENT-SIGNATURE` header, you get 402 back with `PAYMENT-REQUIRED` header containing the payment requirements.

To see the full 402 response with payment requirements:
```bash
curl -i "http://localhost:3000/v1/check?mint=So11111111111111111111111111111111111111112"
```

Look for the `PAYMENT-REQUIRED` header — it contains a base64-encoded JSON blob specifying price ($0.005 USDC), network (solana devnet CAIP-2), and your treasury wallet.

Test rate limiting:
```bash
for i in $(seq 1 65); do
  echo -n "$i: "
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health
done
```

Requests 61-65 should return `429`. Check that rate limit headers are present:
```bash
curl -sI http://localhost:3000/health | grep -i x-ratelimit
```

---

## Part 2: Deploy to Railway

### Why Railway

$5 free credit, no cold starts, Docker-native. The Dockerfile is already set up as a multi-stage build (build with full deps, run with production deps only). Railway auto-detects Dockerfiles.

### Steps

1. **Go to [railway.app](https://railway.app)** and sign in with GitHub.

2. **New Project → Deploy from GitHub repo** → select `tokensafe`.

3. Railway will detect the Dockerfile and start building. The build takes ~60s.

4. **Set environment variables** in Railway's dashboard (Settings → Variables):

   | Variable | Value |
   |----------|-------|
   | `TREASURY_WALLET_ADDRESS` | Your Solana wallet public address |
   | `HELIUS_API_KEY` | Your Helius API key |
   | `SOLANA_NETWORK` | `devnet` (start here, switch to `mainnet` later) |
   | `NODE_ENV` | `production` |
   | `PORT` | `3000` (Railway injects `PORT` automatically, but set it explicitly to be safe) |

   Do NOT set `FACILITATOR_URL` — the default (`https://facilitator.payai.network`) is correct.

5. **Generate a domain** — in Railway's Settings → Networking → Generate Domain. You'll get something like `tokensafe-production-xxxx.up.railway.app`. This is your public URL.

6. **Verify deployment:**
   ```bash
   curl https://tokensafe-production-xxxx.up.railway.app/health
   ```

   Should return the same health JSON as locally, but with `"network": "devnet"`.

### If Railway Credit Runs Out

Render is the fallback. Same Docker deploy, truly free tier, but 30-second cold starts after 15 min idle. For testing that's fine; for production agents it's too slow.

1. Go to [render.com](https://render.com), connect GitHub.
2. New Web Service → select repo → Docker runtime.
3. Set the same env vars.
4. Render assigns a `.onrender.com` URL.

---

## Part 3: Test the Full x402 Flow on Devnet

This is the critical test. You need to verify that an agent can actually pay USDC and get a token safety report back.

### What You Need for Devnet Testing

- **Devnet SOL** — for transaction fees. Get from [faucet.solana.com](https://faucet.solana.com).
- **Devnet USDC** — the x402 payment is in USDC. Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. You'll need to mint some to your test wallet. The Solana x402 guide has instructions, or use the SPL token CLI:
  ```bash
  # If you have solana-cli + spl-token installed:
  spl-token create-account 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --url devnet
  # Then you need someone to mint devnet USDC to that account.
  # The Solana x402 tutorial covers this — check the devnet faucet options.
  ```

### Option A: Use an x402-Compatible Agent/Client

The cleanest test is using an actual x402 client that handles the 402 → sign → retry flow automatically. PayAI has example scripts, and the Solana Foundation tutorial includes a client example.

The flow the client performs:
1. `GET /v1/check?mint=<TOKEN>` → receives 402 + `PAYMENT-REQUIRED` header
2. Parses payment requirements (price, network, payTo address)
3. Signs a USDC transfer transaction
4. Retries with `PAYMENT-SIGNATURE` header containing the signed payment
5. PayAI facilitator verifies + settles the payment on-chain (~400ms)
6. Server returns 200 with the token safety data + `PAYMENT-RESPONSE` header (settlement receipt)

### Option B: Manual cURL Test (Bypasses x402)

If you just want to verify the analysis logic works end-to-end without going through x402 payment, you can temporarily disable the x402 middleware locally:

In `src/index.ts`, comment out line 63 (`app.use(x402Middleware);`), restart with `npm run dev`, then:

```bash
# Wrapped SOL — should be LOW risk
curl -s "http://localhost:3000/v1/check?mint=So11111111111111111111111111111111111111112" | jq .

# USDC — should be LOW risk (note: freeze authority will be ACTIVE, that's normal for USDC)
curl -s "http://localhost:3000/v1/check?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" | jq .
```

**Remember to uncomment the middleware before deploying.**

### What to Verify

- [ ] 402 response includes correct `PAYMENT-REQUIRED` header
- [ ] Payment amount is 5000 (= $0.005 USDC, 6 decimals)
- [ ] `payTo` matches your treasury wallet
- [ ] Network is the correct devnet CAIP-2 identifier
- [ ] After successful payment, 200 response contains full analysis JSON
- [ ] `X-Cache: MISS` on first call, `X-Cache: HIT` on second call within 5 min
- [ ] `X-Response-Time` header present on all responses
- [ ] USDC arrives in your treasury wallet (check on Solana Explorer, devnet)
- [ ] Response time < 2s for fresh analysis
- [ ] Response schema matches what's documented in CLAUDE.md

### Test Tokens to Try

| Token | Expected Risk | Why |
|-------|--------------|-----|
| `So11111111111111111111111111111111111111112` | LOW | Wrapped SOL — renounced authorities, deep liquidity |
| `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | MODERATE | USDC — freeze authority active (Circle can freeze, that's by design) |
| Any random pump.fun token | HIGH-EXTREME | New, concentrated holders, active authorities |

For devnet: token addresses differ from mainnet. Wrapped SOL exists on devnet. For others, find active devnet tokens on Solana Explorer (set network to devnet).

---

## Part 4: Switch to Mainnet

Once devnet testing passes:

1. **Update Railway env vars:**
   - `SOLANA_NETWORK` → `mainnet`
   - `NODE_ENV` → `production`

2. **Railway will auto-redeploy** on env var change.

3. **Test with real USDC** — costs $0.005 per request, you'll receive it in your treasury wallet. Net cost is just the Solana transaction fee (~$0.001).

4. **Verify on Solana Explorer** (mainnet) that USDC settlement lands in your wallet.

---

## Part 5: Agent Discovery Registrations

Without these, no agent finds you. This is the "marketing" — machine-readable service registration.

### 1. MCP Registry — smithery.ai

Go to [smithery.ai](https://smithery.ai), create an account, and register a new tool. Use the MCP tool definition from `src/mcp/tool-definition.json` (or the one in CLAUDE.md). The `description` field is what agent LLMs read to decide if they need this tool — it's already written to match what agents search for.

### 2. MCP Registry — mcp.so

Same process at [mcp.so](https://mcp.so). This is the official MCP registry. Submit the same tool definition.

### 3. x402.org Ecosystem

Submit a PR to the x402 Foundation's GitHub repo. Format matches existing listings at [x402.org/ecosystem](https://www.x402.org/ecosystem):
- Service name: TokenSafe
- Description: Solana token safety scanner — deterministic on-chain analysis, $0.005/request
- URL: your Railway URL
- Payment: USDC on Solana, $0.005/request
- Category: Security / Analytics

### 4. PayAI Marketplace

Register at [payai.network](https://payai.network). PayAI is the facilitator we're using — their marketplace is where agents using PayAI's MCP wallet discover services. Since we already use their facilitator, this is a natural fit.

### 5. x402scan (Merit Systems)

x402scan is an explorer for the x402 ecosystem. There's no automatic discovery — submit manually for inclusion. Check their site for the submission process.

### Optional Amplification

- Post in Solana x402 Discord/Telegram
- dev.to post: "I Built the Cheapest x402 Token Safety Scanner on Solana"
- Answer Solana Stack Exchange questions about token safety

---

## Troubleshooting

**Server starts but 402 response is empty/malformed:**
Check that `TREASURY_WALLET_ADDRESS` is a valid base58 Solana address. The @x402/express middleware constructs payment requirements from it.

**RPC errors (503):**
Helius key invalid or rate-limited. Verify at `https://devnet.helius-rpc.com/?api-key=YOUR_KEY` — should return a JSON-RPC response, not an error page. Free tier is 10 RPS; if you're hammering it, back off.

**x402 payment fails at facilitator:**
Check that `FACILITATOR_URL` points to `https://facilitator.payai.network`. If PayAI is down, there's no fallback in v1 — this is a v2 item (self-hosted verification).

**Railway deploy fails:**
Check build logs. Most likely cause: TypeScript compilation error (should be caught by local `npx tsc --noEmit` first) or npm install failure.

**Cache not working:**
Hit the same mint twice within 5 minutes. First response: `X-Cache: MISS`. Second: `X-Cache: HIT`. Check `/health` — `cache.size` should increment. If size stays 0, the x402 middleware might be rejecting before reaching the check route.

**Rate limiter too aggressive:**
Set `RATE_LIMIT_PER_MINUTE=300` in Railway env vars to raise the limit during testing.
