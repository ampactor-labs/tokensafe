import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// x402 gate → passthrough (no payment header in unit tests). The endpoint's own
// guard, not the gate, enforces "must be x402-paid, not key-authenticated".
vi.mock("../src/x402/middleware.js", () => ({
  x402Middleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/analysis/token-checker.js", () => ({
  checkToken: vi.fn(),
  checkTokenLite: vi.fn(),
}));
vi.mock("../src/utils/ssrf-guard.js", () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
  isPrivateIp: vi.fn().mockReturnValue(false),
  resolveAndCheckIps: vi.fn().mockResolvedValue(undefined),
}));

import { app } from "../src/app.js";
import { initTestDb, closeDb } from "../src/utils/db.js";
import { clearRateLimitBuckets } from "../src/utils/rate-limit.js";
import { createApiKey, clearKeyRateBuckets } from "../src/utils/api-keys.js";

beforeEach(() => {
  closeDb();
  initTestDb();
  clearRateLimitBuckets();
  clearKeyRateBuckets();
});

describe("POST /v1/subscribe (self-serve x402 → Pro key)", () => {
  it("mints a 30-day Pro key on an x402-paid request", async () => {
    const res = await request(app).post("/v1/subscribe").send({});
    expect(res.status).toBe(201);
    expect(res.body.api_key).toMatch(/^tks_/);
    expect(res.body.tier).toBe("pro");
    expect(res.body.monthly_limit).toBeGreaterThan(0);
    // expiry ~30 days out
    const exp = new Date(res.body.expires_at).getTime();
    expect(exp).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(exp).toBeLessThan(Date.now() + 31 * 86_400_000);
  });

  it("rejects key-authenticated requests so one key can't mint free keys", async () => {
    const { fullKey } = createApiKey("existing", "pro");
    const res = await request(app)
      .post("/v1/subscribe")
      .set("X-API-Key", fullKey)
      .send({});
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("PAYMENT_REQUIRED");
  });

  it("returns a usable, distinct key each purchase", async () => {
    const a = await request(app).post("/v1/subscribe").send({});
    const b = await request(app).post("/v1/subscribe").send({});
    expect(a.body.api_key).not.toBe(b.body.api_key);
  });
});
