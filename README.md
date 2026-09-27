# TokenSafe

An API that scores Solana tokens for rug-pull risk from on-chain data and sells the full report for $0.02 through x402 micropayments. A rug pull is a token whose creators drain its value; on-chain means recorded on the public ledger. x402 is an HTTP payment flow: the server answers 402 and the caller's wallet pays in USDC (a dollar stablecoin), then the retry returns a signed report. It is TypeScript on Express; seven of the nine checks read Solana through Helius RPC and two use Jupiter swap quotes.

**Status: shipping.** This repository has no CI, and the paid tool on the MCP endpoint (the interface AI agents call) stays off until a real x402 settlement over it is confirmed.

Live: https://scry-production.up.railway.app/ · Docs: [docs/API.md](docs/API.md) · [INTEGRATION.md](INTEGRATION.md)

## Quick start

The API lives at `https://tokensafe-production.up.railway.app`. The lite check is free and needs no wallet (`mint` is the token's address on Solana; the one below is wrapped SOL):

```bash
curl 'https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112'
```

It returns `risk_score`, `risk_level`, `summary`, flags such as `can_sell` and `authorities_renounced`, and a `full_report` pointer; wrapped SOL scored 5 (LOW) on 2026-09-27. The full check answers 402 until it is paid:

```bash
curl -sS -D - -o /dev/null 'https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112'
```

The `PAYMENT-REQUIRED` header (base64 JSON) asks for 20000 base units of USDC, which has six decimals, so $0.02. Any x402 client, such as `@x402/fetch` as shown in [INTEGRATION.md](INTEGRATION.md), pays it and retries.

For AI agents, the MCP endpoint exposes one free tool, `solana_token_safety_check`, which returns the lite result:

```bash
claude mcp add --transport http tokensafe https://tokensafe-production.up.railway.app/mcp
```

Claude Code can also install it as a plugin with `/plugin marketplace add ampactor-labs/tokensafe` followed by `/plugin install tokensafe@ampactor-labs`.

## Usage

Paid endpoints accept x402 or an `X-API-Key` header. `GET /v1/check` costs $0.02. Batches of up to 5, 20 or 50 mints (`POST /v1/check/batch/{small,medium,large}`) cost $0.07, $0.20 or $0.40. Treasury audits of up to 10 or 50 mints (`POST /v1/audit/{small,standard}`) cost $0.15 or $0.60 and add policy checks and a signed report. `POST /v1/subscribe` costs $49 for a 30-day Pro key good for 6,000 checks a month at 200 requests a minute; keys start with `tks_`. The lite check, `/v1/decide`, `/v1/verify`, `/health`, `/mcp` and the discovery documents are free. Paid routes and `/health` allow 60 requests a minute per IP; the free checks and `/mcp` allow 30. Prices are declared once in `src/discovery/catalog.ts`, which feeds both the payment gate and the discovery documents, so the price a caller pays cannot drift from the price advertised.

`/v1/decide` turns the lite score into a yes or no against a threshold, for callers that only need a gate:

```bash
curl 'https://tokensafe-production.up.railway.app/v1/decide?mint=So11111111111111111111111111111111111111112&threshold=30'
```

On 2026-09-27 that returned `"decision":"SAFE","risk_score":5,"risk_level":"LOW","threshold_used":30,"score_reliable":true`. A degraded result answers UNKNOWN instead of guessing. Every endpoint, the response shapes, the scoring weights and the payment flow are in [docs/API.md](docs/API.md); webhooks, admin key management and error codes are in [INTEGRATION.md](INTEGRATION.md).

## How it works

`src/app.ts` is an Express app. A request passes the discovery documents and `/health`, then the free routes (`/v1/check/lite`, `/v1/decide`, `/v1/verify`, the admin and audit-read routes), then the API-key check, then the x402 gate (`src/x402/middleware.ts`, built on `@x402/express`), and only then the paid routes. A check (`src/analysis/token-checker.ts`) reads the mint account first through Helius (a hosted Solana RPC provider), runs top holders, a buy-and-sell quote round trip on Jupiter (a Solana swap aggregator), metadata and token age in parallel, then liquidity and LP-lock detection, then scores, signs and diffs the result against the previous one for that mint. An uncached check makes between six and eleven RPC calls plus one to three HTTP calls, counted from the check modules with retries excluded. Results stay in a 5-minute in-memory LRU cache of 10,000 entries (30 seconds for degraded results), and concurrent requests for one mint share a single analysis.

| Check | What it detects | Source |
| --- | --- | --- |
| Mint authority | Supply can still be inflated | RPC `getAccountInfo` and `getMint` |
| Freeze authority | Holders' accounts can be frozen | same read |
| Top holders | Concentration in the ten largest accounts, with accounts owned by known DeFi programs excluded | RPC `getTokenLargestAccounts` and `getMultipleAccounts` |
| Liquidity | Whether a swap route exists and how deep it is | Jupiter quote, with DexScreener (a market-data site) as fallback |
| LP lock | Whether a Raydium (a Solana exchange) AMM v4 pool's LP tokens, the receipts for its funds, sit in a known locker or the burn address | RPC, against nine locker program addresses |
| Honeypot | Buying works but selling fails, or a sell tax | Jupiter buy quote against sell quote |
| Metadata | Name and image can still be changed | RPC read of the Metaplex metadata account (the Solana metadata standard) |
| Token age | Launched under 1 or under 24 hours ago | RPC `getSignaturesForAddress` |
| Token-2022 (the newer token program) | Transfer fees, permanent delegate, transfer hooks | Type-length-value (TLV) extension data on the mint account |

The score (`src/analysis/risk-score.ts`) adds fixed penalties per finding and caps the total at 100: an active untrusted mint authority costs 15 to 30 points depending on maturity signals (deep liquidity, an established age, distributed holders), no liquidity 30, a failed sell 30, a permanent delegate 30, and so on. A score of 0 to 20 is LOW, 21 to 40 MODERATE, 41 to 60 HIGH, 61 to 80 CRITICAL and above that EXTREME. A check that cannot run adds an uncertainty penalty instead of silently passing. The full weight table is in [docs/API.md](docs/API.md#scoring).

Two decisions shaped it. I compute the score from chain reads and swap quotes rather than from a third-party security API or a model, because a score with named inputs is reproducible and worth signing: every full report is signed with Ed25519 (a public-key signature scheme) over `{mint, checked_at, rpc_slot, risk_score}`, the response carries `response_signature` and `signer_pubkey` (also shown at `/health`), and `POST /v1/verify` checks a signature for free, so a forwarded verdict is an attestation, a signed statement anyone can confirm. The second is that payment doubles as authentication: x402 replaces API keys as the default, and subscription keys exist for callers without a wallet.

## Deploy

The API runs on Railway; https://tokensafe-production.up.railway.app/health is its liveness page (the root answers 404 because there is no root route). It is built from the `Dockerfile`: a multi-stage `node:22-slim` image that compiles with `tsc`, installs production dependencies with `npm ci --omit=dev` and runs `node dist/index.js` with a `/health` container healthcheck. The deploy trigger and the secrets (treasury wallet, Helius key, Coinbase CDP facilitator keys, signing key) live in Railway; this repository has no deploy workflow. `/health` reports the network, the signer public key and cache statistics; on 2026-09-27 it showed mainnet and 58 days of uptime. Scry (web at the Live link, Telegram at https://t.me/ScryTokenBot) is a separate service whose front end calls this API.

To run your own instance, see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md). In short, you need a treasury wallet address, a Helius API key, and either Coinbase CDP keys or `FACILITATOR_URL=https://facilitator.payai.network`, because the default facilitator answers 401 without CDP keys and the server exits at boot.

## Testing

`npm test` runs vitest: 18 files, 523 tests, 21.5 seconds on Node 22.22.2 (measured 2026-09-27). They cover the score weights and thresholds, every check module against mocked RPC and Jupiter responses, LP-lock detection, delta detection and alerts, the policy engine, the HTTP routes through supertest with the checker and the x402 gate mocked out, API keys, audits, webhooks, the MCP payment gate, response signing with `/v1/verify`, and the discovery documents. Nothing in the suite talks to Solana, Jupiter, DexScreener or a facilitator, and no payment is settled.

`SMOKE_URL=https://tokensafe-production.up.railway.app npm run test:smoke` runs 25 read-only checks against a running instance: health headers, the 402 challenge and its $0.02 amount, batch and discovery routes, MCP `tools/list` and a tool call, the lite and decide endpoints on real tokens, and error shapes. It passed 25 of 25 against production in 19 seconds on 2026-09-27. It does not pay. The paid path is `SVM_PRIVATE_KEY=<base58 keypair> npm run test:x402`, which needs a funded wallet and was not run here.

There is no CI workflow in this repository; the tests run on a developer's machine.

## Limitations

This reads chain state, so it can only catch what chain state shows. A developer who simply sells, or a compromised team wallet, produces a clean report until the moment it happens. A SAFE verdict means the checks found nothing. It does not mean the token is safe.

Honeypot detection compares a Jupiter buy quote with a sell quote for 0.1 SOL, so it misses logic that refuses only some sellers or only after some time, and a token with no Jupiter route scores as unknown (10 points) rather than as a honeypot. LP-lock detection runs only for Raydium AMM v4 pools and recognises nine program addresses from two lockers, Streamflow and UNCX, plus LP tokens sent to the incinerator address (a burn address nobody controls); in such a pool, liquidity locked anywhere else reads as unlocked and costs 15 points, and for every other pool type the lock is never checked.

Liquidity and honeypot depend on Jupiter and DexScreener, which are off-chain services: when they time out the check is marked degraded, an uncertainty penalty applies, and the result is cached for 30 seconds. A normal result is cached for 5 minutes, so a rug in progress can be that stale. Top-holder concentration comes from the 20 largest token accounts, and a token with too many accounts for the RPC to list is marked WIDELY_HELD with 0% concentration.

The signing key is ephemeral unless `RESPONSE_SIGNING_KEY` is set, and `/v1/verify` only checks against the current key, so a signature issued before a restart without that variable cannot be verified. Nothing in this repository is exercised by CI, and the deploy and its secrets live in Railway, so the receipts are the signed response and the on-chain payment.

## Roadmap

- Paid full-check tool over MCP. `src/mcp/payment.ts` gates the `solana_token_safety_check_full` tool with x402 at the JSON-RPC layer, but `PAID_MCP_TOOL_ENABLED` stays `false` until `npm run test:x402-mcp` confirms a real settlement, so the endpoint advertises only the free tool today (confirmed with a live `tools/list` on 2026-09-27).

## License

No license chosen yet. The repository has no LICENSE file and `package.json` has no `license` field; `.claude-plugin/plugin.json` says MIT, so the owner should add the file or correct that claim.
