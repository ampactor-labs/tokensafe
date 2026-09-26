# TokenSafe API reference

Base URL: `https://tokensafe-production.up.railway.app`

This page holds the response shapes, the payment exchange and the discovery
documents. The README's [Usage](../README.md#usage) section has the endpoint
table and short examples. [INTEGRATION.md](../INTEGRATION.md) is the longer
guide for agent developers: every response field, error codes, webhooks,
treasury audits and API key administration.

## Endpoints

Prices come from `src/discovery/catalog.ts`, which also feeds the x402 payment
gate and every discovery document, so the advertised price and the charged
price cannot drift apart. Rate limits are the defaults in `src/config.ts`.

| Endpoint                                    | Price                 | Auth | Rate limit |
| ------------------------------------------- | --------------------- | ---- | ---------- |
| `GET /v1/check?mint=<ADDR>`                 | $0.02 USDC            | x402 | 60/min/IP  |
| `POST /v1/check/batch/{small,medium,large}` | $0.07 / $0.20 / $0.40 | x402 | 60/min/IP  |
| `POST /v1/audit/{small,standard}`           | $0.15 / $0.60         | x402 | 60/min/IP  |
| `POST /v1/subscribe`                        | $49 USDC              | x402 | 60/min/IP  |
| `GET /v1/check/lite?mint=<ADDR>`            | Free                  | None | 30/min/IP  |
| `GET /v1/decide?mint=<ADDR>&threshold=N`    | Free                  | None | 30/min/IP  |
| `POST /v1/verify`                           | Free                  | None | none       |
| `GET /health`                               | Free                  | None | 60/min/IP  |
| `POST /mcp`                                 | Free                  | None | 30/min/IP  |
| `GET /.well-known/x402`                     | Free                  | None | none       |
| `GET /openapi.json`                         | Free                  | None | none       |
| `GET /discovery/resources`                  | Free                  | None | none       |
| `GET /llms.txt`                             | Free                  | None | none       |

Batch tiers take up to 5, 20 and 50 mints. Audit tiers take up to 10 and 50
mints and add a policy evaluation and a signed report. The routes for
webhooks, API key administration, audit history, `/metrics` and `/v1/revenue`
need an admin bearer token or an API key; INTEGRATION.md documents them.

## Paying with x402

x402 is an open protocol that puts the HTTP status 402 Payment Required to
use. An unpaid request gets a 402 with a price. The client's wallet signs a
USDC transfer (USDC is a stablecoin pegged to the US dollar) and resends the
request with the signed payment in a header. A facilitator service checks the
payment and settles it on Solana, and the server then returns the result.

```
Agent  →  GET /v1/check?mint=<TOKEN>
Server →  402 + PAYMENT-REQUIRED header (base64 JSON)
Agent  →  wallet auto-signs $0.02 USDC transfer
Agent  →  GET /v1/check?mint=<TOKEN> + PAYMENT-SIGNATURE header
Server →  200 + full analysis + PAYMENT-RESPONSE receipt
```

USDC settles to the operator's Solana wallet (`TREASURY_WALLET_ADDRESS`)
through the Coinbase CDP facilitator by default, or any other facilitator set
in `FACILITATOR_URL`. Any x402 client handles the exchange;
[`scripts/x402-client.ts`](../scripts/x402-client.ts) is a working one built on
`@x402/fetch`, and INTEGRATION.md shows the decoded 402 payload.

### Subscription keys

`POST /v1/subscribe` is paid once through x402 and returns a Pro API key that
lasts 30 days, with 6,000 checks a month and 200 requests a minute. Send it as
the `X-API-Key` header to skip the per-call payment. The route refuses
requests that already carry an API key, so one key cannot buy another.

## Full check response

`GET /v1/check` returns these top-level fields (from `TokenCheckResult` in
`src/analysis/token-checker.ts`). I have not included a live example because
fetching one costs a payment.

| Field                                            | What it holds                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mint`, `name`, `symbol`                         | The token, with name and symbol from its metadata                                                                                              |
| `checked_at`, `cached_at`                        | When the analysis ran; `cached_at` is set when the result came from the 5-minute cache                                                         |
| `risk_score`, `risk_level`                       | 0 to 100, and LOW (0-20), MODERATE, HIGH, CRITICAL or EXTREME (81-100)                                                                         |
| `score_breakdown`                                | Points per factor, for example `{"mint_authority": 30, "liquidity": 15}`                                                                       |
| `risk_factors`, `summary`                        | The factors as readable strings, and the same joined into one line                                                                             |
| `checks`                                         | Per-check detail: authorities with addresses, supply, top holders, liquidity and LP lock, metadata, honeypot, token age, Token-2022 extensions |
| `degraded`, `degraded_checks`, `data_confidence` | Which checks failed; `data_confidence` is `complete` or `partial`                                                                              |
| `rpc_slot`, `methodology_version`                | The Solana slot the mint was read at, and the scoring version (`1.0.0`)                                                                        |
| `response_signature`, `signer_pubkey`            | The Ed25519 attestation described below                                                                                                        |
| `changes`, `alerts`                              | Delta detection: what changed since this mint's previous check, and ranked alerts                                                              |

Delta detection is automatic. The server keeps each mint's last result for 24
hours, and `changes` and `alerts` fill in when a new check differs from it.

## Lite check response

The free check returns the score and a set of flags, without addresses or
per-check detail. This is the live response for wrapped SOL on 26 September
2026:

```
$ curl -s 'https://tokensafe-production.up.railway.app/v1/check/lite?mint=So11111111111111111111111111111111111111112' | jq .
{
  "mint": "So11111111111111111111111111111111111111112",
  "name": "Wrapped SOL",
  "symbol": "SOL",
  "risk_score": 5,
  "risk_level": "LOW",
  "summary": "No risk factors detected",
  "degraded": false,
  "degraded_checks": [],
  "checks_completed": 6,
  "checks_total": 6,
  "is_token_2022": false,
  "has_risky_extensions": false,
  "can_sell": true,
  "authorities_renounced": true,
  "trusted_authority": false,
  "has_liquidity": true,
  "liquidity_rating": null,
  "top_10_concentration": null,
  "token_age_hours": null,
  "risk_score_delta": null,
  "previous_risk_score": null,
  "previous_risk_level": null,
  "data_confidence": "complete",
  "degraded_note": null,
  "uncertainty_penalties": null,
  "full_report": {
    "url": "https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112",
    "price_usd": "$0.02",
    "payment_protocol": "x402",
    "includes": "authority addresses, holder breakdown, LP lock status, honeypot details, delta detection"
  }
}
```

`liquidity_rating` and `top_10_concentration` are always `null` in the lite
response (`checkTokenLite` sets them so); the values are in the paid report.
`token_age_hours` is `null` here because wrapped SOL has at least 100
transactions, which the age check treats as established.

## Decide response

`GET /v1/decide` compares the lite score with a threshold (default 30) and
answers SAFE, RISKY, or UNKNOWN when checks failed:

```
$ curl -s 'https://tokensafe-production.up.railway.app/v1/decide?mint=So11111111111111111111111111111111111111112&threshold=30'
{"mint":"So11111111111111111111111111111111111111112","decision":"SAFE","risk_score":5,"risk_level":"LOW","threshold_used":30,"score_reliable":true,"full_report":{"url":"https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112","price_usd":"$0.02","payment_protocol":"x402","includes":"authority addresses, holder breakdown, LP lock status, honeypot details, delta detection"}}
```

## Verifiable attestations

Every full check is signed with Ed25519 over the SHA-256 of
`JSON.stringify({mint, checked_at, rpc_slot, risk_score})`. The response
carries `response_signature` (hex) and `signer_pubkey` (the raw 32-byte key in
hex, also shown at `/health`). A party that receives a forwarded result can
confirm the server issued that score for that mint at that slot, either
offline with the public key or through the free endpoint:

```bash
curl -s -X POST https://tokensafe-production.up.railway.app/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{"mint":"<MINT>","checked_at":"<ISO>","rpc_slot":<N>,"risk_score":<N>,"response_signature":"<hex>"}'
# → { "valid": true, "signer_pubkey": "<hex>" }
```

`/v1/verify` checks against the server's current key only. Without
`RESPONSE_SIGNING_KEY` the server makes a new key at every start, so operators
should generate a persistent one with `npm run signing-key:generate` to keep
attestations verifiable across deploys. Treasury audits are signed with the same
key over a SHA-256 hash of their results.

## Discovery documents

Agents and x402 aggregators find the service through machine-readable
documents, all built from `src/discovery/catalog.ts`:

```bash
curl https://tokensafe-production.up.railway.app/openapi.json          # OpenAPI 3.1 (x-x402 per paid op)
curl https://tokensafe-production.up.railway.app/.well-known/x402      # x402 manifest (x402scan compat)
curl https://tokensafe-production.up.railway.app/discovery/resources   # x402 Bazaar resource list
curl https://tokensafe-production.up.railway.app/llms.txt              # agent guide (markdown)
```

`/openapi.json` is also served at `/swagger.json` and `/v3/api-docs`, and the
resource list at the path variants aggregators probe (`src/discovery/router.ts`
lists them).
