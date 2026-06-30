import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Passthrough the x402 gate — discovery routes sit before it, but mocking
// avoids constructing the CDP facilitator client at import time.
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
import { config } from "../src/config.js";
import { usdToBaseUnits } from "../src/discovery/catalog.js";

describe("discovery — OpenAPI", () => {
  it("serves OpenAPI 3.1 at /openapi.json with x402 metadata on paid ops", async () => {
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.servers[0].url).toMatch(/^https?:\/\//);

    const check = res.body.paths["/v1/check"].get;
    expect(check["x-x402"].price).toBe("$0.02");
    expect(check["x-x402"].asset).toBe(config.usdcMint);
    expect(check.responses["402"]).toBeDefined();

    // free endpoints carry no 402
    expect(res.body.paths["/v1/check/lite"].get.responses["402"]).toBeUndefined();
    // mcp surface present
    expect(res.body.paths["/mcp"].post).toBeDefined();
  });

  it("aliases /swagger.json and /v3/api-docs to the same document", async () => {
    const canonical = (await request(app).get("/openapi.json")).body;
    for (const p of ["/swagger.json", "/v3/api-docs"]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe("3.1.0");
      expect(Object.keys(res.body.paths)).toEqual(Object.keys(canonical.paths));
    }
  });
});

describe("discovery — .well-known/x402", () => {
  it("lists every paid route, method-prefixed", async () => {
    const res = await request(app).get("/.well-known/x402");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(Array.isArray(res.body.resources)).toBe(true);
    expect(res.body.resources.length).toBe(6);
    expect(
      res.body.resources.some((r: string) => /^GET \S+\/v1\/check\?mint=/.test(r)),
    ).toBe(true);
    expect(
      res.body.resources.some((r: string) =>
        /^POST \S+\/v1\/audit\/standard$/.test(r),
      ),
    ).toBe(true);
  });
});

describe("discovery — /discovery/resources (x402 Bazaar shape)", () => {
  it("returns the v2 list shape with correct base-unit pricing", async () => {
    const res = await request(app).get("/discovery/resources");
    expect(res.status).toBe(200);
    expect(res.body.x402Version).toBe(2);
    expect(res.body.pagination.total).toBe(res.body.items.length);

    const check = res.body.items.find((i: { resource: string }) =>
      i.resource.endsWith("/v1/check"),
    );
    expect(check.type).toBe("http");
    expect(check.x402Version).toBe(2);
    expect(check.accepts[0].scheme).toBe("exact");
    expect(check.accepts[0].amount).toBe(usdToBaseUnits(0.02)); // "20000"
    expect(check.accepts[0].network).toContain(":");
    expect(check.metadata.info.input.type).toBe("http");

    // MCP tool advertised as a first-class resource
    const mcp = res.body.items.find((i: { type: string }) => i.type === "mcp");
    expect(mcp.metadata.info.input.toolName).toBe("solana_token_safety_check");
  });

  it("honors ?type=mcp", async () => {
    const res = await request(app).get("/discovery/resources?type=mcp");
    expect(res.status).toBe(200);
    expect(res.body.items.every((i: { type: string }) => i.type === "mcp")).toBe(
      true,
    );
  });

  it("honors ?limit and ?offset", async () => {
    const res = await request(app).get("/discovery/resources?limit=2&offset=1");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(2);
    expect(res.body.pagination.offset).toBe(1);
  });

  it("serves the aggregator path variants the crawlers probe", async () => {
    for (const p of [
      "/v2/x402/discovery/resources",
      "/x402/discovery/resources",
      "/v1/x402/discovery/resources",
      "/.well-known/x402/discovery/resources",
    ]) {
      const res = await request(app).get(p);
      expect(res.status, p).toBe(200);
      expect(res.body.x402Version).toBe(2);
    }
  });
});

describe("discovery — llms.txt + api-catalog", () => {
  it("serves llms.txt as markdown", async () => {
    const res = await request(app).get("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("/openapi.json");
    expect(res.text).toContain("$0.02 USDC");
    expect(res.text).toContain("$0.60 USDC");
  });

  it("serves RFC 9727 api-catalog linkset", async () => {
    const res = await request(app).get("/.well-known/api-catalog");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/linkset+json");
    const body = JSON.parse(res.text);
    expect(body.linkset[0]["service-desc"][0].href).toMatch(/\/openapi\.json$/);
  });
});
