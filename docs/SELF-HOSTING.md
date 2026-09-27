# Self-hosting TokenSafe

## Requirements

- Node 22 or newer. The Dockerfile uses `node:22-slim`; this guide was verified on Node 22.22.2 with npm 10.9.7 on 2026-09-27.
- A Solana wallet address that will receive USDC (`TREASURY_WALLET_ADDRESS`). The server validates it as a public key at boot and refuses to start otherwise.
- A Helius API key (`HELIUS_API_KEY`). The free tier at https://helius.dev is enough to start. Every chain read goes through Helius, so with a wrong key every check answers 503 `RPC_ERROR`.
- An x402 facilitator the server can reach. The default is Coinbase CDP (`https://api.cdp.coinbase.com/platform/v2/x402`), which needs `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` from https://portal.cdp.coinbase.com. Without them the facilitator answers 401 to the startup sync, the `@x402/express` middleware rejects, and `src/index.ts` treats the unhandled rejection as fatal and exits (measured 2026-09-27). The alternative is `FACILITATOR_URL=https://facilitator.payai.network`, which needs no keys.

## Run it locally

```bash
git clone https://github.com/ampactor-labs/tokensafe
cd tokensafe
cp .env.example .env
# Set TREASURY_WALLET_ADDRESS, HELIUS_API_KEY, and either the CDP keys or FACILITATOR_URL
npm ci
npm run dev
```

`npm run dev` runs `tsx watch src/index.ts`. Within a few seconds the log shows `TokenSafe started` with the port (3000 unless `PORT` is set) and the network (`devnet` unless `SOLANA_NETWORK=mainnet`), and `curl http://localhost:3000/health` returns `{"status":"ok", ...}` with the signer public key and the facilitator URL. `GET /v1/check` answers 402 locally exactly as in production. On a clean checkout with the PayAI facilitator, `/health` answered 8 seconds after `npm run dev` (measured 2026-09-27).

`npm run build` compiles to `dist/` with `tsc` (26 seconds here) and `npm start` runs `node dist/index.js`.

## Configuration

Everything is read from the environment (`src/config.ts`); `.env.example` documents each variable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TREASURY_WALLET_ADDRESS` | required | Solana address that receives USDC |
| `HELIUS_API_KEY` | required | Helius RPC key; `HELIUS_API_KEY_BACKUP` adds a second key used after 3 consecutive failures, for 5 minutes |
| `SOLANA_NETWORK` | `devnet` | `mainnet` or `devnet`; picks the Helius endpoint, the CAIP-2 network id and the USDC mint |
| `FACILITATOR_URL` | Coinbase CDP | x402 facilitator; PayAI needs no keys |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | unset | Required with the CDP facilitator |
| `PORT` | `3000` | Railway injects its own |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-IP limit on paid routes and `/health` |
| `LITE_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP limit on the lite check, decide and MCP |
| `RESPONSE_SIGNING_KEY` | unset (ephemeral key) | Hex PKCS8 Ed25519 private key; see below |
| `BACKUP_RPC_URL` | unset | Any Solana RPC used when `getTokenLargestAccounts` fails on the primary |
| `PUBLIC_BASE_URL` | derived from the request | Canonical origin in the discovery documents; set it behind a proxy |
| `X402_OWNERSHIP_PROOF` | unset | base58 signature of `PUBLIC_BASE_URL` by the treasury key, for the x402scan listing |
| `PAID_MCP_TOOL_ENABLED` | `false` | Advertise and gate the paid MCP tool |
| `WEBHOOK_ADMIN_BEARER` | unset | Bearer for webhook and API-key management and `/metrics`; without it those routes answer 401 and `/metrics` 404 |
| `DB_PATH` | `data/tokensafe.db` | SQLite file for API keys, webhooks and audits; `:memory:` for tests |
| `MAX_WEBHOOKS_PER_TOKEN` | `100` | Active subscriptions per mint |
| `MONITOR_INTERVAL_MS` | `300000` | Webhook monitor poll interval |
| `PRO_MONTHLY_LIMIT`, `PRO_RATE_LIMIT`, `ENTERPRISE_RATE_LIMIT` | `6000`, `200`, `600` | API key tiers |

On mainnet the server also warms its cache at boot by checking wrapped SOL, USDC, USDT, JUP and BONK (`WARM_TOKENS` in `src/index.ts`).

## Signing key

Without `RESPONSE_SIGNING_KEY` the server generates a new Ed25519 key at every start, so attestations stop verifying after a restart and `/health` shows a different `signer_pubkey`. Generate a persistent one and set it in the environment:

```bash
npm run signing-key:generate
```

It prints one hex line to stdout (the value to set) and the instructions to stderr. Keep it secret.

## Docker

The `Dockerfile` builds a three-stage image: `tsc` in the first stage, production dependencies with the native `better-sqlite3` build in the second, and a slim runtime with `dist/`, `public/` and a `/app/data` directory in the third. It exposes port 3000 and runs a `/health` healthcheck every 30 seconds.

```bash
docker build -t tokensafe .
docker run --rm -p 3000:3000 --env-file .env tokensafe
```

This is how the production instance on Railway runs. The image build was not exercised while writing this guide because no Docker daemon was available.

## Check a running instance

```bash
SMOKE_URL=http://localhost:3000 npm run test:smoke
```

`scripts/smoke.ts` sends 25 read-only requests: health headers, the 402 challenge and its $0.02 amount, batch and discovery routes, MCP `tools/list` and one tool call, the lite and decide endpoints, and the error shapes. It needs a working Helius key on the target because it checks real tokens. Against production it passed 25 of 25 in 19 seconds on 2026-09-27.

To exercise a real payment, generate a devnet wallet, fund it from the faucets the script names, and run the paid client against a devnet instance:

```bash
npm run wallet:generate
SVM_PRIVATE_KEY=<base58 keypair> npm run test:x402
```

`npm run test:x402-mcp` does the same through the paid MCP tool and is the check `PAID_MCP_TOOL_ENABLED` waits on. Neither paid script was run while writing this guide. Both mention a `DEPLOY.md` that is not in the repository.

## Production notes

- Set `SOLANA_NETWORK=mainnet`, `PUBLIC_BASE_URL` to the public https origin, `RESPONSE_SIGNING_KEY`, and `WEBHOOK_ADMIN_BEARER` if you want key management, webhooks or `/metrics` (Prometheus format).
- The SQLite file under `DB_PATH` holds API keys, webhook subscriptions and audits; give it a persistent volume. Audits expire after 90 days.
- `app.set("trust proxy", 1)` is on, so rate limits key on the first `X-Forwarded-For` hop; run it behind one proxy.
- The API has no root route: `/` answers 404, `/health` is the liveness check.
