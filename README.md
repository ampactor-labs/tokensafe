# TokenSafe

An HTTP API that scores Solana tokens from 0 to 100 for rug-pull risk, using data read from the blockchain. A rug pull is when a token's creators take the money out, for example by printing new supply or draining the pool. A score is free; the full report costs $0.02 in USDC over x402, a protocol that turns HTTP 402 Payment Required into an automatic payment, so no account is needed. It is TypeScript on Express, reads the chain through Helius RPC, and signs each full report with Ed25519.

**Status: shipping.** It runs on Solana mainnet, but this repo has no CI and no automated test settles a real payment.

Live: https://tokensafe-production.up.railway.app/llms.txt · Docs: [INTEGRATION.md](INTEGRATION.md)

## Quick start

Check a token against the live API. This call is free:

```bash
curl 'https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112'
```

A mint address identifies a token on Solana; this one is wrapped SOL. The reply is JSON with `risk_score` (0 is safest), `risk_level`, a one-line `summary` and a `full_report` link to the paid check. On 26 September 2026 it returned a score of 5 (LOW) for this mint; [docs/API.md](docs/API.md#lite-check-response) has the full output. The lite check allows 30 calls a minute per IP address.

To try it in a browser, Scry (https://scry-production.up.railway.app) is a web front end, with a Telegram bot at [@ScryTokenBot](https://t.me/ScryTokenBot). Their code is not in this repository.

### Run it locally

You need Node 22, a Solana wallet address to receive payments, and a free [Helius](https://helius.dev) API key for RPC access (RPC is the JSON API that Solana nodes expose).

```bash
git clone https://github.com/ampactor-labs/tokensafe
cd tokensafe
cp .env.example .env
# In .env: set TREASURY_WALLET_ADDRESS and HELIUS_API_KEY, then either set
# CDP_API_KEY_ID and CDP_API_KEY_SECRET, or set
# FACILITATOR_URL=https://facilitator.payai.network
npm install
npm run dev
```

Then `curl http://localhost:3000/health` from another terminal returns `"status":"ok"`. The default facilitator (Coinbase CDP) rejects calls without CDP keys, and the server shuts itself down on that error about a second after starting. With the PayAI facilitator it started and served a 402 challenge without keys. `.env.example` starts on devnet; set `SOLANA_NETWORK=mainnet` to check mainnet tokens.

## Usage

The free endpoints need nothing. The paid ones need an x402 payment or a subscription key. Response shapes, the discovery documents and the signing details are in [docs/API.md](docs/API.md). [INTEGRATION.md](INTEGRATION.md) is the longer guide for agent developers, with webhooks, treasury audits, error codes and API key administration.

### Endpoints

| Endpoint                                    | Price                 | Auth | Rate limit |
| ------------------------------------------- | --------------------- | ---- | ---------- |
| `GET /v1/check?mint=<ADDR>`                 | $0.02 USDC            | x402 | 60/min/IP  |
| `POST /v1/check/batch/{small,medium,large}` | $0.07 / $0.20 / $0.40 | x402 | 60/min/IP  |
| `POST /v1/audit/{small,standard}`           | $0.15 / $0.60         | x402 | 60/min/IP  |
| `POST /v1/subscribe`                        | $49 USDC              | x402 | 60/min/IP  |
| `GET /v1/check/lite?mint=<ADDR>`            | Free                  | None | 30/min/IP  |
| `GET /v1/decide?mint=<ADDR>&threshold=N`    | Free                  | None | 30/min/IP  |
| `POST /v1/verify`                           | Free                  | None | none       |
| `POST /mcp`                                 | Free                  | None | 30/min/IP  |
| `GET /health`                               | Free                  | None | 60/min/IP  |

Batches take up to 5, 20 or 50 mints. Audits take up to 10 or 50 and add a policy check and a signed report. `/v1/decide` answers SAFE, RISKY or UNKNOWN against a score threshold (default 30). `POST /v1/subscribe` is paid once and returns a 30-day Pro API key (6,000 checks a month, 200 requests a minute); send it as `X-API-Key` to skip per-call payment.

### Paying with x402

x402 uses the HTTP status 402 Payment Required. An unpaid request to a paid route gets a 402 with the price. The client's wallet signs a USDC transfer (USDC is a stablecoin pegged to the US dollar) and resends the request with the payment in a header. A facilitator service verifies the payment and settles it on Solana, and then the server answers:

```
Agent  →  GET /v1/check?mint=<TOKEN>
Server →  402 + PAYMENT-REQUIRED header (base64 JSON)
Agent  →  wallet auto-signs $0.02 USDC transfer
Agent  →  GET /v1/check?mint=<TOKEN> + PAYMENT-SIGNATURE header
Server →  200 + full analysis + PAYMENT-RESPONSE receipt
```

Any x402 client handles this exchange. [`scripts/x402-client.ts`](scripts/x402-client.ts) is one: `SVM_PRIVATE_KEY=<base58 keypair> SMOKE_URL=https://tokensafe-production.up.railway.app npm run test:x402` pays for one check from a funded wallet and prints the result.

### MCP (Claude Code, Cursor, Windsurf)

MCP (Model Context Protocol) lets AI assistants call tools. The `/mcp` endpoint offers one free tool, `solana_token_safety_check`, which returns the lite result:

```bash
claude mcp add --transport http tokensafe https://tokensafe-production.up.railway.app/mcp
```

A paid full-check tool sits behind `PAID_MCP_TOOL_ENABLED`, which is off by default.

### Verifying a signed result

Every full report is signed with Ed25519 over `{mint, checked_at, rpc_slot, risk_score}`, where `rpc_slot` is the Solana block slot the mint was read at. The response carries `response_signature` and `signer_pubkey` (also shown at `/health`). Anyone who is handed a result can check that the server issued it, offline with the public key or with the free endpoint:

```bash
curl -s -X POST https://tokensafe-production.up.railway.app/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{"mint":"<MINT>","checked_at":"<ISO>","rpc_slot":<N>,"risk_score":<N>,"response_signature":"<hex>"}'
# → { "valid": true, "signer_pubkey": "<hex>" }
```

## How it works

A check reads the token's mint account over RPC first, because the supply and decimals feed the later steps. It then runs the top-holder, metadata and token-age reads in parallel with a Jupiter buy-and-sell quote for 0.1 SOL (Jupiter is a Solana swap aggregator). The buy quote also feeds the liquidity check, which falls back to DexScreener when Jupiter has no route. Only a failed mint read fails the request. Any other failed check adds an uncertainty penalty to the score and is listed in `degraded_checks`.

`src/analysis/risk-score.ts` turns the results into points, capped at 100: 0-20 is LOW, 21-40 MODERATE, 41-60 HIGH, 61-80 CRITICAL and 81-100 EXTREME. Every point appears in `score_breakdown`. An active mint or freeze authority costs fewer points the more maturity signals the token shows: deep liquidity, 100 or more transactions, and top ten holders with less than 30% of supply. It costs nothing when the authority belongs to a known issuer (Circle, Tether, Paxos, and three staking pools for mint authority).

### What it checks

| Check            | What it detects                                                                         | Source                                |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| Mint authority   | A key that can still print new supply                                                   | RPC `getAccountInfo`                  |
| Freeze authority | A key that can freeze any holder's balance                                              | RPC `getAccountInfo`                  |
| Top holders      | Supply held by a few wallets (accounts owned by known DeFi programs are left out)       | RPC `getTokenLargestAccounts`         |
| Liquidity        | Whether the token trades, and the price impact of a small trade                         | Jupiter quote API, DexScreener        |
| LP locks         | Whether the pool's share tokens (LP tokens) are locked or burned, so it can't be pulled | RPC, 9 known locker program addresses |
| Honeypot         | A token you can buy but not sell, or a hidden sell tax                                  | Jupiter buy and sell quotes           |
| Metadata         | A name and image the owner can still change after launch                                | RPC, Metaplex metadata account        |
| Token age        | A launch less than a day old                                                            | RPC `getSignaturesForAddress`         |
| Token-2022       | Transfer fees, a permanent delegate that can move anyone's tokens, transfer hooks       | The mint's extension data             |

Token-2022 is Solana's newer token program, whose optional extensions can add fees or code to every transfer.

### Decisions

I chose to read chain state directly and call no third-party security or scoring APIs (such as GoPlus or RugCheck), so each point in a score traces to an account or a quote the server read itself. It also means the signature attests to the server's own reading at a given slot. There are no machine-learning models.

Results sit in a 5-minute in-memory LRU cache of 10,000 entries (30 seconds for degraded results), and concurrent requests for the same mint share one analysis. SQLite (`better-sqlite3`) stores API keys, webhook subscriptions and audit results. A background job re-checks watched mints every 5 minutes and calls a subscriber's webhook whenever a score is at or above its threshold. Prices live once in `src/discovery/catalog.ts`, which builds both the x402 payment gate and every discovery document, so the advertised price and the charged price cannot drift apart.

## Project layout

```
src/
  analysis/        token-checker.ts runs the checks, risk-score.ts scores them
    checks/        one file per check, plus Jupiter and DexScreener clients
  x402/            payment gate, built from the catalog
  discovery/       catalog.ts (routes and prices), OpenAPI, llms.txt
  mcp/             MCP server and the paid MCP tool
  routes/          check, verify, audit, admin (webhooks, API keys, metrics)
  utils/           cache, signing, SQLite, rate limits, webhook delivery
  app.ts           middleware order: discovery, free routes, API key, x402, paid routes
test/              vitest suites
scripts/           smoke test, paid x402 clients, key generators
INTEGRATION.md     full API guide for agent developers
```

## Deploy

The API runs on Railway at https://tokensafe-production.up.railway.app, on Solana mainnet with the Coinbase CDP facilitator (both shown at `/health`). Railway builds the `Dockerfile`: three stages on `node:22-slim` that compile the TypeScript, build `better-sqlite3` with production dependencies, and run `node dist/index.js` with a Docker health check on `/health` every 30 seconds. The deploy trigger, secrets and service settings live in Railway, so this repo does not show how a change reaches production.

Production needs the variables in `.env.example` with `SOLANA_NETWORK=mainnet` and CDP keys. Set a persistent `RESPONSE_SIGNING_KEY` (`npm run signing-key:generate` prints one) so signatures stay verifiable across deploys, and put `data/` on a persistent volume, because the SQLite file there holds API keys, webhooks and audits.

## Testing

```bash
npm test
```

On 26 September 2026 this ran 523 tests in 18 files, all passing, in about 55 seconds on Node 22.22.2. They cover the risk scoring, each check against mocked RPC and Jupiter responses, delta detection, the discovery documents, API keys and subscriptions, audits and policies, webhooks, response signing and `/v1/verify`, the paid MCP tool's payment handling, and the HTTP routes through supertest. Every HTTP test replaces the x402 payment gate with a pass-through, so no automated test settles a payment. `npm run build` type-checks the code.

These scripts run against a live server and are not part of `npm test`:

- `npm run test:smoke` checks a running instance (`SMOKE_URL`, default `http://localhost:3000`): health and headers, that paid routes answer 402 with a $0.02 price, the free lite and decide checks, MCP, and error codes. It pays nothing.
- `npm run test:x402` pays for one real `/v1/check` with a funded wallet and prints the response and receipt.
- `npm run test:x402-mcp` does the same for the paid MCP tool.

There is no CI workflow in this repo.

## Limitations

TokenSafe reads chain state, so it can only catch what chain state shows. A developer who sells their holdings, a rug organized off-chain, or a compromised team wallet all produce a clean report right up until they act. A LOW score means only that these checks found nothing.

- Honeypot detection compares one Jupiter buy quote with one sell quote. It misses contracts that refuse only some sellers, or refuse only after some time.
- LP-lock detection reads only Raydium AMM v4 pools. It recognizes nine locker program addresses (Streamflow and UNCX) plus the burn address, so liquidity locked anywhere else reads as unlocked and costs 15 points. A pool counts as locked if any one of the top five LP-token holders is a known locker or the burn address.
- Tokens with millions of holders are too big for the RPC holder query. They are reported as `WIDELY_HELD` and scored as spread out, with no concentration figure.
- `/v1/verify` checks against the server's current key only. Without `RESPONSE_SIGNING_KEY`, every restart makes a new key and older signatures stop verifying.
- A paid check can return a result up to 5 minutes old from the cache; `cached_at` says when.

## License

MIT, as declared in `.claude-plugin/plugin.json`. The repository has no LICENSE file yet.
