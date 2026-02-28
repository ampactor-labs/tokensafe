import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { config } from "../config.js";

const facilitator = new HTTPFacilitatorClient({
  url: config.facilitatorUrl,
});

const resourceServer = new x402ResourceServer(facilitator);
registerExactSvmScheme(resourceServer);

export const x402Middleware = paymentMiddleware(
  {
    "GET /v1/check": {
      accepts: {
        scheme: "exact",
        network: config.networkCaip2,
        payTo: config.treasuryWallet,
        price: "$0.005",
      },
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
    "GET /v1/batch": {
      accepts: {
        scheme: "exact",
        network: config.networkCaip2,
        payTo: config.treasuryWallet,
        price: "$0.008",
      },
      description:
        "Batch check up to 10 Solana tokens at once — full safety analysis for each, 20% discount vs individual checks",
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "GET",
              queryParams: {
                mints:
                  "So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              },
            },
            output: {
              type: "json",
              example: {
                token_count: 2,
                results: [
                  { mint: "So1...", risk_score: 15, risk_level: "LOW" },
                ],
                errors: [],
              },
            },
          },
        },
      },
    },
    "GET /v1/monitor": {
      accepts: {
        scheme: "exact",
        network: config.networkCaip2,
        payTo: config.treasuryWallet,
        price: "$0.005",
      },
      description:
        "Monitor up to 10 Solana tokens — returns current safety state plus changes since last check, with risk alerts for critical changes",
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "GET",
              queryParams: {
                mints: "So11111111111111111111111111111111111111112",
              },
            },
            output: {
              type: "json",
              example: {
                results: [
                  {
                    mint: "So1...",
                    risk_score: 15,
                    alerts: [],
                    changes: null,
                  },
                ],
                errors: [],
              },
            },
          },
        },
      },
    },
  },
  resourceServer,
);
