#!/usr/bin/env tsx

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const WSOL = "So11111111111111111111111111111111111111112";

// Mainnet vs devnet USDC/USDT — resolved from /health network field
const TOKENS: Record<string, { usdc: string; usdt: string }> = {
  mainnet: {
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
  devnet: {
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    // No official USDT on devnet — skip
    usdt: "",
  },
};

let passed = 0;
let failed = 0;
let skipped = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (firstErr) {
    // Retry once — Railway edge occasionally returns 502 under rapid sequential requests
    try {
      await sleep(500);
      await fn();
      console.log(`  \x1b[32m✓\x1b[0m ${name} (retry)`);
      passed++;
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${name}`);
      console.log(`    ${(err as Error).message}`);
      failed++;
    }
  }
}

function skip(name: string, reason: string): void {
  console.log(`  \x1b[33m○\x1b[0m ${name} (skip: ${reason})`);
  skipped++;
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);

  // --- Connectivity + network detection ---
  let network: string;
  try {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    network = body.network ?? "devnet";
  } catch {
    console.error(
      `\x1b[31mServer not reachable at ${BASE}.\x1b[0m Start with: npm run dev`,
    );
    process.exit(1);
  }

  const tokens = TOKENS[network] ?? TOKENS.devnet;
  console.log(`  Network: ${network}\n`);

  // === PHASE 1: Health (no rate limit pressure — uses health bucket) ===
  console.log("Health:");

  await check("GET /health → 200", async () => {
    const res = await fetch(`${BASE}/health`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === "ok", `expected status:"ok", got ${body.status}`);
    assert(typeof body.version === "string", "missing version");
    assert(typeof body.network === "string", "missing network");
    assert(typeof body.uptime === "number", "missing uptime");
    assert(typeof body.cache?.size === "number", "missing cache.size");
  });

  await check("X-Response-Time header present", async () => {
    const res = await fetch(`${BASE}/health`);
    const header = res.headers.get("x-response-time");
    assert(
      header !== null && /^\d+ms$/.test(header),
      `expected \\d+ms, got ${header}`,
    );
  });

  await check("X-RateLimit headers present", async () => {
    const res = await fetch(`${BASE}/health`);
    assert(
      res.headers.get("x-ratelimit-limit") !== null,
      "missing x-ratelimit-limit",
    );
    assert(
      res.headers.get("x-ratelimit-remaining") !== null,
      "missing x-ratelimit-remaining",
    );
    assert(
      res.headers.get("x-ratelimit-reset") !== null,
      "missing x-ratelimit-reset",
    );
  });

  // === PHASE 2: x402 gate + batch (uses paid bucket, not lite) ===
  console.log("\nx402 payment gate:");

  await check("GET /v1/check → 402 with PAYMENT-REQUIRED header", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${WSOL}`);
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const pr = res.headers.get("payment-required");
    assert(pr !== null && pr.length > 0, "missing PAYMENT-REQUIRED header");
  });

  await check("402 PAYMENT-REQUIRED contains $0.008 price", async () => {
    const res = await fetch(`${BASE}/v1/check?mint=${WSOL}`);
    const pr = res.headers.get("payment-required");
    assert(pr !== null, "missing header");
    const decoded = JSON.parse(Buffer.from(pr!, "base64").toString());
    // x402 v2 nests pricing under accepts[]
    const accept = decoded.accepts?.[0];
    assert(accept !== undefined, "missing accepts[0] in payment requirements");
    assert(
      accept.amount === "8000",
      `expected amount=8000, got ${accept.amount}`,
    );
    assert(
      accept.scheme === "exact",
      `expected scheme=exact, got ${accept.scheme}`,
    );
  });

  await check(
    "GET /v1/check without mint → 402 (x402 gate fires first)",
    async () => {
      const res = await fetch(`${BASE}/v1/check`);
      assert(
        res.status === 402,
        `expected 402 (x402 gate fires before validation), got ${res.status}`,
      );
    },
  );

  console.log("\nBatch endpoints:");

  await check("POST /v1/check/batch/small → 402 with x402 gate", async () => {
    const res = await fetch(`${BASE}/v1/check/batch/small`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mints: [WSOL] }),
    });
    assert(res.status === 402, `expected 402, got ${res.status}`);
    const pr = res.headers.get("payment-required");
    assert(pr !== null && pr.length > 0, "missing PAYMENT-REQUIRED header");
  });

  await check("POST /v1/check/batch/medium → 402 with x402 gate", async () => {
    const res = await fetch(`${BASE}/v1/check/batch/medium`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mints: [WSOL] }),
    });
    assert(res.status === 402, `expected 402, got ${res.status}`);
  });

  await check("POST /v1/check/batch/large → 402 with x402 gate", async () => {
    const res = await fetch(`${BASE}/v1/check/batch/large`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mints: [WSOL] }),
    });
    assert(res.status === 402, `expected 402, got ${res.status}`);
  });

  // === PHASE 3: Discovery + MCP (separate bucket) ===
  console.log("\nDiscovery:");

  await check("GET /.well-known/x402 → 200 JSON", async () => {
    const res = await fetch(`${BASE}/.well-known/x402`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(
      body.resources && body.resources.length > 0,
      "missing resources in discovery doc",
    );
    assert(typeof body.instructions === "string", "missing instructions");
    assert(
      body.instructions.includes("TokenSafe"),
      "instructions missing product name",
    );
    assert(body.version === 1, `expected version=1, got ${body.version}`);
  });

  console.log("\nMCP endpoint:");

  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  await check("MCP tools/list includes check tool", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    assert(data !== undefined, "no SSE data line in response");
    const parsed = JSON.parse(data!.replace("data: ", ""));
    const names = parsed.result.tools.map((t: { name: string }) => t.name);
    assert(
      names.includes("solana_token_safety_check"),
      `missing solana_token_safety_check, got: ${names.join(", ")}`,
    );
    assert(
      !names.includes("solana_token_safety_preview"),
      "deprecated solana_token_safety_preview still present",
    );
  });

  await check(
    "MCP check tool returns lite data with absolute URL",
    async () => {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "solana_token_safety_check",
            arguments: { mint_address: WSOL },
          },
        }),
      });
      const text = await res.text();
      const data = text.split("\n").find((l) => l.startsWith("data: "));
      assert(data !== undefined, "no SSE data line");
      const parsed = JSON.parse(data!.replace("data: ", ""));
      const result = JSON.parse(parsed.result.content[0].text);
      assert(result.mint === WSOL, `wrong mint: ${result.mint}`);
      assert(typeof result.risk_score === "number", "missing risk_score");
      assert(!result.checks, "MCP leaks full checks");
      assert(!result.changes, "MCP leaks changes");
      assert(
        result.full_report.url.startsWith("http"),
        `full_report.url must be absolute, got: ${result.full_report.url}`,
      );
    },
  );

  await check("MCP invalid base58 → graceful isError, not 502", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "solana_token_safety_check",
          arguments: { mint_address: "not-a-valid-mint" },
        },
      }),
    });
    assert(
      res.status === 200,
      `expected 200 (MCP error in body), got ${res.status}`,
    );
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data: "));
    assert(data !== undefined, "no SSE data line");
    const parsed = JSON.parse(data!.replace("data: ", ""));
    assert(
      parsed.result.isError === true,
      "expected isError: true for invalid mint",
    );
  });

  // === PHASE 4: Lite endpoint — paced to stay within 10/min ===
  // Lite + decide share a 10/min bucket. Consolidate assertions on shared
  // responses and pace between groups. Budget: 9 requests across ~35s.
  console.log("\nLite endpoint:");

  // Call 1: wSOL — shape, enrichment, paywall integrity all in one request
  await check("GET /v1/check/lite → 200 with full shape", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.headers.get("x-cache") !== null, "missing X-Cache header");
    assert(
      res.headers.get("x-ratelimit-limit") !== null,
      "missing x-ratelimit-limit",
    );
    const body = await res.json();
    assert(body.mint === WSOL, `expected mint=${WSOL}, got ${body.mint}`);
    assert(typeof body.risk_score === "number", "missing risk_score");
    assert(typeof body.risk_level === "string", "missing risk_level");
    assert(typeof body.summary === "string", "missing summary");
    assert(
      typeof body.full_report === "object" && body.full_report !== null,
      "missing full_report object",
    );
    assert(
      body.full_report.price_usd === "$0.008",
      `full_report price expected $0.008, got ${body.full_report.price_usd}`,
    );
    assert(
      body.full_report.payment_protocol === "x402",
      "full_report missing payment_protocol",
    );
    // Enrichment fields
    assert(
      typeof body.can_sell === "boolean" || body.can_sell === null,
      "can_sell: expected boolean|null",
    );
    assert(
      typeof body.authorities_renounced === "boolean",
      "authorities_renounced: expected boolean",
    );
    assert(
      typeof body.has_liquidity === "boolean",
      "has_liquidity: expected boolean",
    );
    assert(
      typeof body.token_age_hours === "number" || body.token_age_hours === null,
      "token_age_hours: expected number|null",
    );
    // Data confidence fields
    assert(
      body.data_confidence === "complete" || body.data_confidence === "partial",
      `bad data_confidence: ${body.data_confidence}`,
    );
    assert(
      body.degraded_note === null || typeof body.degraded_note === "string",
      "bad degraded_note type",
    );
    const confidence = res.headers.get("x-data-confidence");
    assert(
      confidence === "complete" || confidence === "partial",
      `bad X-Data-Confidence header: ${confidence}`,
    );
    // Paywall integrity — no paid-only fields
    assert(!body.checks, "lite leaks checks");
    assert(body.changes === undefined, "lite leaks changes");
    assert(body.alerts === undefined, "lite leaks alerts");
    assert(body.rpc_slot === undefined, "lite leaks rpc_slot");
    assert(
      body.response_signature === undefined,
      "lite leaks response_signature",
    );
    assert(body.score_breakdown === undefined, "lite leaks score_breakdown");
  });

  // Call 2: cache hit (wSOL just fetched)
  await check("Second lite call returns X-Cache: HIT", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
    const cache = res.headers.get("x-cache");
    assert(cache !== null && cache.includes("HIT"), `expected X-Cache containing HIT, got ${cache}`);
  });

  // Call 3-4: error paths (fast, no RPC)
  await check("GET /v1/check/lite with bad mint → 400", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=not-a-real-mint`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error?.code === "INVALID_MINT_ADDRESS",
      `expected INVALID_MINT_ADDRESS, got ${body.error?.code}`,
    );
  });

  await check(
    "GET /v1/check/lite without mint → 400 MISSING_REQUIRED_PARAM",
    async () => {
      const res = await fetch(`${BASE}/v1/check/lite`);
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = await res.json();
      assert(
        body.error?.code === "MISSING_REQUIRED_PARAM",
        `expected MISSING_REQUIRED_PARAM, got ${body.error?.code}`,
      );
    },
  );

  // Call 5: non-mint address → 404
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  await check("Non-mint account → 404 TOKEN_NOT_FOUND (not 503)", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${TOKEN_PROGRAM}`);
    assert(
      res.status === 404,
      `expected 404 for non-mint account, got ${res.status}`,
    );
    const body = await res.json();
    assert(
      body.error?.code === "TOKEN_NOT_FOUND",
      `expected TOKEN_NOT_FOUND, got ${body.error?.code}`,
    );
  });

  await sleep(7000);

  // Call 6: network-aware USDC
  console.log("\nReal tokens:");

  if (network === "mainnet") {
    await check("GET /v1/check/lite USDC → 200 LOW risk", async () => {
      const res = await fetch(`${BASE}/v1/check/lite?mint=${tokens.usdc}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.risk_level === "LOW", `expected LOW, got ${body.risk_level}`);
    });
  } else {
    // Devnet USDC is a faucet token with different authorities / no liquidity
    await check(`GET /v1/check/lite USDC (${network}) → 200`, async () => {
      const res = await fetch(`${BASE}/v1/check/lite?mint=${tokens.usdc}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(typeof body.risk_score === "number", "missing risk_score");
    });
  }

  if (tokens.usdt && network === "mainnet") {
    await check("GET /v1/check/lite USDT → 200 LOW risk", async () => {
      const res = await fetch(`${BASE}/v1/check/lite?mint=${tokens.usdt}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = await res.json();
      assert(body.risk_level === "LOW", `expected LOW, got ${body.risk_level}`);
    });
  } else {
    skip(
      "GET /v1/check/lite USDT → 200 LOW risk",
      network === "devnet" ? `no USDT on ${network}` : "skipped",
    );
  }

  await sleep(7000);

  // === PHASE 5: Decide endpoint (shares lite bucket) ===
  // Calls 7-9: decide uses cached wSOL (fast, no extra RPC)
  console.log("\nDecide endpoint:");

  await check("GET /v1/decide wSOL → SAFE with default threshold", async () => {
    const res = await fetch(`${BASE}/v1/decide?mint=${WSOL}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.mint === WSOL, `expected mint=${WSOL}`);
    assert(
      body.decision === "SAFE" ||
        body.decision === "RISKY" ||
        body.decision === "UNKNOWN",
      `bad decision: ${body.decision}`,
    );
    assert(typeof body.risk_score === "number", "missing risk_score");
    assert(typeof body.threshold_used === "number", "missing threshold_used");
    assert(typeof body.full_report === "object", "missing full_report");
  });

  await check("GET /v1/decide with custom threshold", async () => {
    const res = await fetch(`${BASE}/v1/decide?mint=${WSOL}&threshold=0`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(
      body.threshold_used === 0,
      `expected threshold_used=0, got ${body.threshold_used}`,
    );
  });

  await check("GET /v1/decide without mint → 400", async () => {
    const res = await fetch(`${BASE}/v1/decide`);
    assert(res.status === 400, `expected 400, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error?.code === "MISSING_REQUIRED_PARAM",
      `expected MISSING_REQUIRED_PARAM, got ${body.error?.code}`,
    );
  });

  // === PHASE 6: Error handling (404 handler — no rate limit) ===
  console.log("\nError handling:");

  await check("GET /unknown → 404", async () => {
    const res = await fetch(`${BASE}/no-such-route`);
    assert(res.status === 404, `expected 404, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error?.code === "NOT_FOUND",
      `expected NOT_FOUND, got ${body.error?.code}`,
    );
  });

  await check("Removed endpoints → 404", async () => {
    const res1 = await fetch(`${BASE}/v1/batch?mints=${WSOL}`);
    assert(
      res1.status === 404,
      `expected 404 for /v1/batch, got ${res1.status}`,
    );
    const res2 = await fetch(`${BASE}/v1/monitor?mints=${WSOL}`);
    assert(
      res2.status === 404,
      `expected 404 for /v1/monitor, got ${res2.status}`,
    );
  });

  // --- Summary ---
  const total = passed + failed + skipped;
  const parts = [`${passed} passed`, `${failed} failed`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  console.log(`\n${parts.join(", ")} (${total} total)\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
