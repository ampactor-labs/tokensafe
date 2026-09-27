# TokenSafe API reference

Base URL: `https://tokensafe-production.up.railway.app`. Every route below is served by `src/app.ts`. Prices, titles and example payloads come from one catalog, `src/discovery/catalog.ts`, which also generates the discovery documents, so the price a caller pays and the price an aggregator indexes are the same number. [INTEGRATION.md](../INTEGRATION.md) covers webhooks, admin key management, response headers and error codes.

## Authentication

Paid routes take one of two credentials:

- **x402.** Send no credential, receive a 402 with a `PAYMENT-REQUIRED` header, pay in USDC on Solana and retry with a `PAYMENT-SIGNATURE` header. See [Payment flow](#payment-flow).
- **API key.** Send `X-API-Key: tks_...`. A key skips the x402 gate, counts against its monthly limit and has its own rate limit. Keys come from `POST /v1/subscribe` (paid once with x402) or from the admin API described in INTEGRATION.md.

Free routes need nothing. `GET /v1/audit/history` and `GET /v1/audit/:id/report` need either an API key or the admin bearer token.

## Endpoints

| Endpoint | Price (USDC) | Auth | Rate limit per IP |
| --- | --- | --- | --- |
| `GET /v1/check?mint=<ADDR>` | $0.02 | x402 or API key | 60/min |
| `POST /v1/check/batch/small` (up to 5 mints) | $0.07 | x402 or API key | 60/min |
| `POST /v1/check/batch/medium` (up to 20) | $0.20 | x402 or API key | 60/min |
| `POST /v1/check/batch/large` (up to 50) | $0.40 | x402 or API key | 60/min |
| `POST /v1/audit/small` (up to 10) | $0.15 | x402 or API key | 60/min |
| `POST /v1/audit/standard` (up to 50) | $0.60 | x402 or API key | 60/min |
| `POST /v1/subscribe` | $49 | x402 only | 60/min |
| `GET /v1/check/lite?mint=<ADDR>` | free | none | 30/min |
| `GET /v1/decide?mint=<ADDR>&threshold=N` | free | none | 30/min |
| `POST /v1/verify` | free | none | none |
| `GET /health` | free | none | 60/min |
| `POST /mcp` | free | none | 30/min |
| `GET /v1/audit/history`, `GET /v1/audit/:id/report` | free | API key or admin bearer | none |
| `GET /openapi.json`, `GET /.well-known/x402`, `GET /discovery/resources`, `GET /llms.txt`, `GET /.well-known/api-catalog` | free | none | none |

The limits are the defaults in `src/config.ts` (`RATE_LIMIT_PER_MINUTE=60`, `LITE_RATE_LIMIT_PER_MINUTE=30`) and a deployment can change them. Pro keys default to 6,000 checks a month and 200 requests a minute; enterprise keys to 600 a minute with no monthly cap. Every request has a 30-second ceiling and answers 504 `TIMEOUT` past it.

`POST /v1/subscribe` must be paid with x402: a request that already carries a valid API key is rejected with 402, so one key cannot mint further keys. The returned key lasts 30 days and is shown once.

## What it checks

| Check | What it detects | Source |
| --- | --- | --- |
| Mint authority | An active authority can inflate supply. Six known issuer authorities (Circle USDC, Tether USDT, Marinade mSOL, Jito jitoSOL, SolBlaze bSOL, Paxos PYUSD) are trusted and carry no penalty. | RPC `getAccountInfo` and `getMint` |
| Freeze authority | An active authority can freeze holders' accounts. Three issuer authorities (Circle, Tether, Paxos) are trusted. | same read |
| Top holders | Share of supply in the largest account and in the ten largest, after excluding accounts owned by known DeFi programs (pools, stake pools, lockers). | RPC `getTokenLargestAccounts`, then `getMultipleAccounts` to resolve owners |
| Liquidity | Whether a swap route exists and how deep it is: DEEP under 1% price impact, MODERATE under 5%, SHALLOW under 20%, NONE above. | Jupiter quote for 0.1 SOL; DexScreener pair liquidity in USD as the fallback |
| LP lock | For Raydium AMM v4 pools, whether the pool's LP tokens sit with a known locker (Streamflow or UNCX, nine program addresses in `src/analysis/checks/known-programs.ts`) or were sent to the incinerator address. | RPC pool account, then `getTokenLargestAccounts` on the LP mint |
| Honeypot | A buy quote exists but no sell quote (cannot sell), or the round trip loses more than price impact and fees explain (sell tax). Losses under 1% count as noise. | Jupiter buy and sell quotes |
| Metadata | Whether the name, symbol and image URI can still be changed (`mutable`). Token-2022 embedded metadata is read when there is no Metaplex account. | RPC Metaplex metadata account |
| Token age | Hours since the first signature on the mint. A mint with 100 or more signatures counts as established and skips the age penalty. | RPC `getSignaturesForAddress` (a probe of 2, then up to 100) |
| Token-2022 | `TransferFeeConfig`, `PermanentDelegate` and `TransferHook` extensions, parsed from the mint account's TLV data. | same mint read |

A check that fails (RPC timeout, rate limit, no route) is listed in `degraded_checks`, `data_confidence` becomes `partial`, and an uncertainty penalty is added, so missing data reads as risk. Degraded results are cached for 30 seconds instead of 5 minutes.

## Scoring

`src/analysis/risk-score.ts` adds fixed penalties and caps the total at 100. Maturity signals (deep liquidity, established age, top-10 share under 30%) soften the authority penalties for tokens that clearly have a market.

| Finding | Points |
| --- | --- |
| Active untrusted mint authority | 30; 20 with one maturity signal; 15 with two or more |
| Active untrusted freeze authority | 25; 15 with one maturity signal; 10 with two or more |
| Top 10 holders own over 30% / 50% / 80% | 10 / 20 / 25 |
| Top holder owns over 10% / 20% / 30% / 50% | 5 / 10 / 15 / 25 |
| No liquidity | 30 |
| Liquidity present but LP not locked (Raydium AMM v4 only) | 15 |
| Mutable metadata | 10; 5 with two or more maturity signals |
| Token under 1 hour old / under 24 hours | 10 / 5 |
| Token-2022 permanent delegate | 30 |
| Token-2022 transfer fee above 0 / 10% or more / above 50% | 5 / 10 / 20 |
| Token-2022 transfer hook | 15 |
| Cannot sell (honeypot) | 30 |
| Sell side unverifiable (no Jupiter route) | 10 |
| Sell tax above 0 / above 10% | 5 / 15 |
| Uncertainty: `top_holders`, `liquidity`, `honeypot`, `token_age`, `metadata` unavailable | 20, 10, 10, 5, 3 |

Levels: 0 to 20 LOW, 21 to 40 MODERATE, 41 to 60 HIGH, 61 to 80 CRITICAL, 81 to 100 EXTREME. `score_breakdown` in the full response lists every penalty applied, `risk_factors` names them in words, and `methodology_version` (`1.0.0`) names the scoring version. A fully degraded result reaches 48 points from uncertainty alone, which is HIGH and never CRITICAL.

## Full check response

`GET /v1/check` returns the fields of `TokenCheckResult` in `src/analysis/token-checker.ts`. Values below are placeholders; the field names and nesting are real, and the nested check objects carry more fields than shown (holder details, pool and LP-mint addresses, extension details).

```json
{
  "mint": "<MINT>",
  "name": "Example",
  "symbol": "EXM",
  "checked_at": "2026-09-27T00:00:00.000Z",
  "cached_at": null,
  "risk_score": 15,
  "risk_level": "LOW",
  "checks": {
    "mint_authority": { "status": "RENOUNCED", "authority": null, "risk": "SAFE" },
    "freeze_authority": { "status": "ACTIVE", "authority": "<ADDR>", "risk": "DANGEROUS" },
    "supply": { "total": "1000000000000", "decimals": 9 },
    "top_holders": { "status": "OK", "top_10_percentage": 12.5, "top_1_percentage": 3.2, "holder_count_estimate": null, "top_holders_detail": [], "note": null, "risk": "SAFE" },
    "liquidity": { "status": "OK", "has_liquidity": true, "primary_pool": "Raydium", "liquidity_rating": "DEEP", "lp_locked": true, "lp_lock_percentage": 98.2, "lp_locker": "Streamflow", "risk": "SAFE" },
    "metadata": { "status": "OK", "update_authority": "<ADDR>", "mutable": false, "has_uri": true, "uri": "https://...", "risk": "SAFE" },
    "honeypot": { "status": "OK", "can_sell": true, "sell_tax_bps": 0, "note": null, "risk": "SAFE" },
    "token_age_hours": 8760,
    "token_age_minutes": 525600,
    "created_at": "2025-09-27T00:00:00.000Z",
    "token_program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "is_token_2022": false,
    "token_2022_extensions": null
  },
  "rpc_slot": 300000000,
  "methodology_version": "1.0.0",
  "risk_factors": ["active freeze authority"],
  "summary": "active freeze authority",
  "degraded": false,
  "degraded_checks": [],
  "data_confidence": "complete",
  "degraded_note": null,
  "score_breakdown": { "freeze_authority": 15 },
  "response_signature": "<hex>",
  "signer_pubkey": "<hex>",
  "changes": null,
  "alerts": []
}
```

`cached_at` is set when the result came from the 5-minute cache; the `X-Cache` header says `HIT` or `MISS`. Paid responses carry `Cache-Control: private, no-store`.

## Lite check response

`GET /v1/check/lite` is the free subset. This is the live response for wrapped SOL on 2026-09-27, pretty-printed:

```json
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

`liquidity_rating` and `top_10_concentration` are always `null` on the lite route; the numbers are part of the paid report. Free responses carry `Cache-Control: public, max-age=300`.

## Decide response

`GET /v1/decide?mint=<ADDR>&threshold=N` compares the lite score with a threshold (default 30, clamped to 0 to 100) and answers `SAFE`, `RISKY`, or `UNKNOWN` when the result is degraded. Live on 2026-09-27:

```json
{"mint":"So11111111111111111111111111111111111111112","decision":"SAFE","risk_score":5,"risk_level":"LOW","threshold_used":30,"score_reliable":true,"full_report":{"url":"https://tokensafe-production.up.railway.app/v1/check?mint=So11111111111111111111111111111111111111112","price_usd":"$0.02","payment_protocol":"x402","includes":"authority addresses, holder breakdown, LP lock status, honeypot details, delta detection"}}
```

An UNKNOWN answer adds `note` and `degraded_checks`.

## Batch and audit responses

Batch routes take `{"mints": ["<ADDR>", ...]}` (JSON body up to 256 KB) and answer `{total, succeeded, failed, checked_at, results}`, where each entry is a full check result or `{mint, status: "error", error: {code, message}}`. Mints are checked concurrently and one failure does not fail the batch. `X-Cache` is `PARTIAL` when any mint came from cache.

Audit routes take the same `mints` array plus an optional `policy` (`{rules: [{id, field, operator, value, action, message}]}`, with `field` a dot path into the check result and `action` either `block` or `warn`). Without a policy the default in `src/analysis/policy-engine.ts` applies: block on score above 80, no liquidity, honeypot or a permanent delegate; warn on score above 60, an active mint or freeze authority, or any transfer fee. The answer adds `audit_id`, `aggregate_risk_score`, `risk_distribution`, `policy_violations` and an `attestation` (`{hash, signature, signer_pubkey}`, the Ed25519 signature over the SHA-256 of `{mints, results, timestamp}`). Audits are stored in SQLite for 90 days; `GET /v1/audit/history` lists them and `GET /v1/audit/:id/report` renders one as Markdown.

## Delta detection

Every full check is kept for 24 hours (an in-memory LRU of 5,000 mints, `src/utils/monitor-cache.ts`). The next check of the same mint fills `changes` and `alerts` from the rules in `src/analysis/delta.ts`:

| Change | Severity |
| --- | --- |
| Mint or freeze authority status or address changed | CRITICAL |
| Liquidity lost, LP unlocked, or a token that could be sold no longer can | CRITICAL |
| Top-10 or top-1 share moved by more than 5 points, LP lock share fell by more than 20 points, price impact rose by more than 10 points, liquidity rating degraded, sell tax appeared or rose by more than 5 points | HIGH |
| Holder risk level worsened, metadata became mutable | WARNING |

`changes` is `null` when no rule fired and the score moved by 10 or less. `changes` carries `previous_checked_at`, `risk_score_delta`, `previous_risk_score`, `previous_risk_level` and `changed_fields`; `alerts` lists the CRITICAL and HIGH changes as messages, plus a score-only alert when the score moved by more than 10 without a field change. The history lives in process memory, so a restart clears it; the webhook monitor in INTEGRATION.md is the persistent alternative.

## Payment flow

1. The client calls a paid route without payment.
2. The server answers `402` with a `PAYMENT-REQUIRED` header: base64 JSON with `accepts[0]` set to scheme `exact`, network `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet), `amount` in USDC base units (`20000` for $0.02), `asset` `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC) and `payTo` set to the operator's treasury wallet.
3. The client's wallet signs the USDC transfer and repeats the request with a `PAYMENT-SIGNATURE` header.
4. The facilitator verifies and settles the payment; the server answers `200` with the report and a `PAYMENT-RESPONSE` receipt header carrying the payer and transaction.

The facilitator is Coinbase CDP by default (`FACILITATOR_URL`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`); PayAI (`https://facilitator.payai.network`) is the keyless alternative in `.env.example`. USDC settles to the operator's Solana wallet. `@x402/fetch` handles steps 1 to 4; INTEGRATION.md shows the client code and `scripts/x402-client.ts` is a runnable copy.

## Verifiable attestations

Every full check is signed with Ed25519 over the SHA-256 of `JSON.stringify({mint, checked_at, rpc_slot, risk_score})` (`src/utils/response-signer.ts`). The response carries `response_signature` and `signer_pubkey` as hex; `/health` shows the same public key. Anyone holding a response can confirm the server issued it:

```bash
curl -s -X POST https://tokensafe-production.up.railway.app/v1/verify \
  -H 'Content-Type: application/json' \
  -d '{"mint":"<MINT>","checked_at":"<ISO>","rpc_slot":<N>,"risk_score":<N>,"response_signature":"<hex>"}'
# { "valid": true, "signer_pubkey": "<hex>" }
```

Posting the whole check response works too; extra fields are ignored. `/v1/verify` checks against the current key only, so operators set a persistent `RESPONSE_SIGNING_KEY` (`npm run signing-key:generate`) or signatures stop verifying after a restart. The trustless path, which needs no call to the server, is in [INTEGRATION.md](../INTEGRATION.md#verifying-response-signatures). Because the score is computed from named chain reads and quotes, the signature says who issued the verdict and over which slot; a treasury or compliance process can keep it as proof of diligence.

## MCP

`POST /mcp` is a stateless MCP Streamable HTTP endpoint (`src/mcp/server.ts`). It advertises one tool, `solana_token_safety_check`, with input `{mint_address: string}`; the result is the lite response as JSON text, and an invalid address answers with `isError: true` rather than an HTTP error. A paid tool, `solana_token_safety_check_full`, exists behind `PAID_MCP_TOOL_ENABLED` and is off in production. `server.json` describes the server for the MCP registry, and `.claude-plugin/` packages it as a Claude Code plugin.

## Discovery documents

All of these derive from the catalog (`src/discovery/docs.ts`) and are served before the payment gate:

- `GET /openapi.json`, also at `/swagger.json` and `/v3/api-docs`: OpenAPI 3.1 with `x-x402` and `x-payment-info` on each paid operation.
- `GET /.well-known/x402`: the x402scan manifest, with the ownership proof when `X402_OWNERSHIP_PROOF` is set.
- `GET /discovery/resources`, also at `/v2/x402/discovery/resources`, `/x402/discovery/resources`, `/v1/x402/discovery/resources` and `/.well-known/x402/discovery/resources`: the x402 Bazaar resource list, with `?type=http|mcp`, `limit` and `offset`.
- `GET /llms.txt`, also at `/.well-known/llms.txt`: the agent guide in Markdown.
- `GET /.well-known/api-catalog`: an RFC 9727 link set pointing at the OpenAPI document.

`PUBLIC_BASE_URL` fixes the origin these documents advertise; without it the origin is derived from the request.
