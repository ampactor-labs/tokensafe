#!/usr/bin/env tsx
/**
 * Generate a persistent Ed25519 response-signing key.
 *
 * By default the server uses an EPHEMERAL key that changes on every restart,
 * so attestations can't be verified across deploys. Run this once and set the
 * output as RESPONSE_SIGNING_KEY in your environment (e.g. Railway) so the
 * signer pubkey (exposed at /health) and /v1/verify stay stable.
 *
 *   npx tsx scripts/generate-signing-key.ts
 *   # → copy the hex line into RESPONSE_SIGNING_KEY
 */

import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("ed25519");
const der = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;

// stdout: the value to set (hex PKCS8 DER — exactly what response-signer.ts loads)
process.stdout.write(der.toString("hex") + "\n");

// stderr: human guidance (won't pollute the value if piped)
process.stderr.write(
  "\nSet the hex string above as RESPONSE_SIGNING_KEY (Railway → Variables).\n" +
    "Keep it secret. Once set, /health signer_pubkey and /v1/verify survive restarts.\n",
);
