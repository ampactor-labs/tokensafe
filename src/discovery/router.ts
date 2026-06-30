import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import {
  buildWellKnownX402,
  buildDiscoveryResources,
  buildOpenApi,
  buildLlmsTxt,
  buildApiCatalog,
} from "./docs.js";

/**
 * Serves every machine-readable discovery document. Mounted BEFORE the
 * x402 payment gate so crawlers reach real 200s instead of a 402 or the
 * 404 handler. All documents derive from the canonical catalog.
 */
export const discoveryRouter = Router();

/** Canonical https origin — PUBLIC_BASE_URL (must match the ownership-proof
 * signature) if set, else derived from the proxied request. */
function baseUrlFrom(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function jsonHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
}

function intParam(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

// OpenAPI 3.1 — canonical + the two paths generic crawlers probe.
discoveryRouter.get(
  ["/openapi.json", "/swagger.json", "/v3/api-docs"],
  (req, res) => {
    jsonHeaders(res);
    res.json(buildOpenApi(baseUrlFrom(req)));
  },
);

// x402 legacy/compat manifest.
discoveryRouter.get("/.well-known/x402", (req, res) => {
  jsonHeaders(res);
  res.json(buildWellKnownX402(baseUrlFrom(req)));
});

// x402 Bazaar resource list — canonical path + the aggregator variants the
// production logs show being probed.
discoveryRouter.get(
  [
    "/discovery/resources",
    "/v2/x402/discovery/resources",
    "/x402/discovery/resources",
    "/v1/x402/discovery/resources",
    "/.well-known/x402/discovery/resources",
  ],
  (req, res) => {
    jsonHeaders(res);
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    res.json(
      buildDiscoveryResources(baseUrlFrom(req), {
        type,
        limit: intParam(req.query.limit),
        offset: intParam(req.query.offset),
      }),
    );
  },
);

// Agent-readable guide.
discoveryRouter.get(["/llms.txt", "/.well-known/llms.txt"], (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.type("text/markdown").send(buildLlmsTxt(baseUrlFrom(req)));
});

// RFC 9727 API catalog → points crawlers at the OpenAPI spec from one well-known URL.
discoveryRouter.get("/.well-known/api-catalog", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  res
    .type("application/linkset+json")
    .send(JSON.stringify(buildApiCatalog(baseUrlFrom(req))));
});
