import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { SignJWT, importPKCS8 } from "jose";
import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Build CDP JWT auth headers if CDP API keys are configured.
 * The CDP facilitator requires ES256 JWTs in the Authorization header.
 */
function buildCdpAuthHeaders() {
  if (!config.cdpApiKeyId || !config.cdpApiKeySecret) return undefined;

  // The CDP key secret is a base64-encoded 64-byte Ed25519 seed — but the
  // CDP platform actually uses ES256 (P-256 ECDSA). The private key from
  // the portal is an EC key encoded as base64.
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");

    // Import the EC private key from base64 PEM-like format
    const pemKey = `-----BEGIN EC PRIVATE KEY-----\n${config.cdpApiKeySecret}\n-----END EC PRIVATE KEY-----`;
    const privateKey = await importPKCS8(pemKey, "ES256");

    const makeJwt = async (uri: string) =>
      await new SignJWT({
        sub: config.cdpApiKeyId,
        iss: "cdp",
        aud: ["cdp_service"],
        nbf: now,
        exp: now + 120,
        uris: [uri],
        nonce,
      })
        .setProtectedHeader({
          alg: "ES256",
          kid: config.cdpApiKeyId,
          typ: "JWT",
          nonce,
        })
        .sign(privateKey);

    const baseUrl = config.facilitatorUrl;
    const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
      makeJwt(`${baseUrl}/verify`),
      makeJwt(`${baseUrl}/settle`),
      makeJwt(`${baseUrl}/supported`),
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
