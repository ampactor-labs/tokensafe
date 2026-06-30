import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type RouteConfig } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SignJWT, importJWK } from "jose";
import crypto from "node:crypto";
import { config } from "../config.js";
import {
  paidEntries,
  buildBazaarInfo,
  usdToPriceString,
} from "../discovery/catalog.js";

/**
 * Build CDP JWT auth headers if CDP API keys are configured.
 * The CDP API key secret is a base64-encoded Ed25519 key (64 bytes: 32 seed + 32 pubkey).
 * JWTs are signed with EdDSA and sent as Bearer tokens.
 */
function buildCdpAuthHeaders() {
  if (!config.cdpApiKeyId || !config.cdpApiKeySecret) return undefined;

  return async () => {
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");

    // Decode the base64 Ed25519 key (64 bytes: 32 seed + 32 public key)
    const decoded = Buffer.from(config.cdpApiKeySecret, "base64");
    const seed = decoded.subarray(0, 32);
    const publicKey = decoded.subarray(32);

    // Import as JWK for EdDSA signing (matches @coinbase/cdp-sdk jwt.ts)
    const jwk = {
      kty: "OKP" as const,
      crv: "Ed25519",
      d: seed.toString("base64url"),
      x: publicKey.toString("base64url"),
    };
    const key = await importJWK(jwk, "EdDSA");

    // Parse facilitator URL to get host + path
    const url = new URL(config.facilitatorUrl);
    const hostAndBase = `${url.host}${url.pathname}`;

    const makeJwt = async (method: string, path: string) =>
      await new SignJWT({
        sub: config.cdpApiKeyId,
        iss: "cdp",
        uris: [`${method} ${hostAndBase}${path}`],
      })
        .setProtectedHeader({
          alg: "EdDSA",
          kid: config.cdpApiKeyId,
          typ: "JWT",
          nonce,
        })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 120)
        .sign(key);

    const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
      makeJwt("POST", "/verify"),
      makeJwt("POST", "/settle"),
      makeJwt("GET", "/supported"),
    ]);

    return {
      verify: { Authorization: `Bearer ${verifyJwt}` },
      settle: { Authorization: `Bearer ${settleJwt}` },
      supported: { Authorization: `Bearer ${supportedJwt}` },
    };
  };
}

const facilitator = new HTTPFacilitatorClient({
  url: config.facilitatorUrl,
  createAuthHeaders: buildCdpAuthHeaders(),
});

const resourceServer = new x402ResourceServer(facilitator);
registerExactSvmScheme(resourceServer);

const baseAccepts = {
  scheme: "exact" as const,
  network: config.networkCaip2,
  payTo: config.treasuryWallet,
};

// Build the route → payment config from the canonical catalog so the price a
// caller pays can never drift from what /openapi.json + /discovery advertise.
// Every paid route declares the `bazaar` extension so the CDP facilitator
// catalogs each endpoint on its first settled payment.
const routesConfig: Record<string, RouteConfig> = {};
for (const entry of paidEntries) {
  routesConfig[`${entry.method} ${entry.path}`] = {
    accepts: { ...baseAccepts, price: usdToPriceString(entry.priceUsd) },
    description: entry.description,
    extensions: { bazaar: buildBazaarInfo(entry) },
  };
}

export const x402Middleware = paymentMiddleware(routesConfig, resourceServer);
