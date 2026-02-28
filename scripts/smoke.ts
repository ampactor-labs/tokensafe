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
