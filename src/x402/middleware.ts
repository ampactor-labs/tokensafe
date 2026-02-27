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
    },
  },
  resourceServer,
);
