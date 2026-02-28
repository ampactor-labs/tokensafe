#!/usr/bin/env tsx

const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const WSOL = "So11111111111111111111111111111111111111112";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${(err as Error).message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function main() {
  console.log(`\nSmoke testing ${BASE}\n`);

  // Connectivity check
  try {
    await fetch(`${BASE}/health`);
  } catch {
    console.error(
      `\x1b[31mServer not reachable at ${BASE}.\x1b[0m Start with: npm run dev`,
    );
    process.exit(1);
  }

  // --- Health ---
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

  // --- Lite endpoint (free) ---
  console.log("\nLite endpoint:");

  await check("GET /v1/check/lite → 200 with risk score", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.mint === WSOL, `expected mint=${WSOL}, got ${body.mint}`);
    assert(typeof body.risk_score === "number", "missing risk_score");
    assert(typeof body.risk_level === "string", "missing risk_level");
    assert(typeof body.summary === "string", "missing summary");
    assert(
      typeof body.full_report === "object" && body.full_report !== null,
      "missing full_report object",
    );
    assert(typeof body.full_report.url === "string", "full_report missing url");
    assert(
      body.full_report.price_usd === "$0.008",
      `full_report price expected $0.008, got ${body.full_report.price_usd}`,
    );
    assert(
      body.full_report.payment_protocol === "x402",
      "full_report missing payment_protocol",
    );
    assert(
      !body.checks,
      "lite response should NOT include checks (that's the paid endpoint)",
    );
  });

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

  await check("X-Cache header present on lite", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
    const cache = res.headers.get("x-cache");
    assert(
      cache !== null && (cache.includes("HIT") || cache.includes("MISS")),
      `expected header containing HIT or MISS, got ${cache}`,
    );
  });

  // --- Real token (not just wSOL) ---
  console.log("\nReal tokens:");

  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  await check("GET /v1/check/lite USDC → 200 LOW risk", async () => {
    const res = await fetch(`${BASE}/v1/check/lite?mint=${USDC}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.risk_level === "LOW", `expected LOW, got ${body.risk_level}`);
    assert(body.symbol === "USDC", `expected USDC, got ${body.symbol}`);
  });

  // --- Lite endpoint does NOT leak paid fields ---
  console.log("\nPaywall integrity:");

  await check(
    "Lite response has no checks/changes/alerts/rpc_slot",
    async () => {
      const res = await fetch(`${BASE}/v1/check/lite?mint=${WSOL}`);
      const body = await res.json();
      assert(!body.checks, "lite leaks checks");
      assert(body.changes === undefined, "lite leaks changes");
      assert(body.alerts === undefined, "lite leaks alerts");
      assert(body.rpc_slot === undefined, "lite leaks rpc_slot");
      assert(
        body.response_signature === undefined,
        "lite leaks response_signature",
      );
      assert(body.risk_factors === undefined, "lite leaks risk_factors");
      assert(body.checked_at === undefined, "lite leaks checked_at");
      assert(body.degraded_checks === undefined, "lite leaks degraded_checks");
    },
  );

  // --- x402 gate ---
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
      // x402 middleware fires before param validation, so 402 is expected
      assert(
        res.status === 402,
        `expected 402 (x402 gate fires before validation), got ${res.status}`,
      );
    },
  );

  // --- Discovery ---
  console.log("\nDiscovery:");

  await check("GET /.well-known/x402 → 200 JSON", async () => {
    const res = await fetch(`${BASE}/.well-known/x402`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert(
      body.resources && body.resources.length > 0,
      "missing resources in discovery doc",
    );
  });

  // --- MCP endpoint ---
  console.log("\nMCP endpoint:");

  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  await check("MCP tools/list includes preview, not check", async () => {
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
    assert(
      !names.includes("solana_token_safety_lite"),
      "deprecated solana_token_safety_lite still present",
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
      // full_report URL must be absolute (not relative)
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

  // --- Non-mint address handling ---
  console.log("\nNon-mint address:");

  // Token program ID is a valid base58 address but not a token mint
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

  // --- Error handling ---
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
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
