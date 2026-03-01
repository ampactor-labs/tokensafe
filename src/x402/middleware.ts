import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { config } from "../config.js";

const facilitator = new HTTPFacilitatorClient({
  url: config.facilitatorUrl,
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
  },
  resourceServer,
);
