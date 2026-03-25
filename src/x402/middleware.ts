import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SignJWT, importJWK } from "jose";
import crypto from "node:crypto";
import { config } from "../config.js";

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

export const x402Middleware = paymentMiddleware(
  {
    "GET /v1/check": {
      accepts: { ...baseAccepts, price: "$0.008" },
      description:
        "Solana token safety check — mint authority, freeze authority, top holder concentration, liquidity, honeypot detection, metadata mutability, token age, Token-2022 extension risks, risk score",
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "GET",
              queryParams: {
                mint: "So11111111111111111111111111111111111111112",
              },
            },
            output: {
              type: "json",
              example: {
                mint: "So11111111111111111111111111111111111111112",
                risk_score: 15,
                risk_level: "LOW",
                summary: "Low risk. All authorities renounced, deep liquidity.",
              },
            },
          },
        },
      },
    },
    "POST /v1/check/batch/small": {
      accepts: { ...baseAccepts, price: "$0.025" },
      description: "Batch token safety check — up to 5 tokens at $0.005/token",
    },
    "POST /v1/check/batch/medium": {
      accepts: { ...baseAccepts, price: "$0.08" },
      description: "Batch token safety check — up to 20 tokens at $0.004/token",
    },
    "POST /v1/check/batch/large": {
      accepts: { ...baseAccepts, price: "$0.15" },
      description: "Batch token safety check — up to 50 tokens at $0.003/token",
    },
    "POST /v1/audit/small": {
      accepts: { ...baseAccepts, price: "$0.08" },
      description:
        "Treasury audit — up to 10 tokens with policy evaluation and compliance report",
    },
    "POST /v1/audit/standard": {
      accepts: { ...baseAccepts, price: "$0.30" },
      description:
        "Treasury audit — up to 50 tokens with policy evaluation and compliance report",
    },
  },
  resourceServer,
);
