#!/usr/bin/env tsx
/**
 * Sign the x402scan ownership proof with the treasury key.
 *
 * x402scan marks a listing "ownership verified" when the discovery documents
 * carry an Ed25519 signature, base58-encoded, over the bare origin string
 * (e.g. "https://tokensafe-production.up.railway.app"), made by the payTo
 * address. This prints that signature for X402_OWNERSHIP_PROOF.
 *
 * The treasury secret key is read from stdin so it never lands in shell
 * history or argv. Accepted forms: the base58 64-byte secret key a wallet
 * exports (Phantom, Solflare, Backpack), or the JSON byte array of a
 * solana-keygen file.
 *
 *   read -rs K && printf %s "$K" | \
 *     PUBLIC_BASE_URL=https://tokensafe-production.up.railway.app \
 *     TREASURY_WALLET_ADDRESS=<treasury address> \
 *     npm run ownership-proof:sign; unset K
 *   # → copy the base58 line into X402_OWNERSHIP_PROOF
 *
 * Re-sign whenever PUBLIC_BASE_URL or the treasury wallet changes; the old
 * proof stops verifying against either.
 */

import crypto from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { base58 } from "@scure/base";

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

if (process.stdin.isTTY) {
  fail("pipe the secret key on stdin (see the usage at the top of this file); typing it here would echo it");
}

const base = process.env.PUBLIC_BASE_URL;
if (!base) fail("set PUBLIC_BASE_URL to the origin the discovery documents advertise");
// x402scan signs and verifies the origin alone: no path, no trailing slash.
const origin = new URL(base).origin;

const raw = (await new Response(process.stdin as unknown as ReadableStream).text()).trim();
if (!raw) fail("no secret key on stdin");

let secretKey: Uint8Array;
try {
  secretKey = raw.startsWith("[")
    ? Uint8Array.from(JSON.parse(raw) as number[])
    : base58.decode(raw);
} catch {
  fail("secret key is neither base58 nor a JSON byte array");
}
if (secretKey.length !== 64) fail(`secret key is ${secretKey.length} bytes, expected 64`);

// fromSecretKey checks that the public half matches the seed.
let keypair: Keypair;
try {
  keypair = Keypair.fromSecretKey(secretKey);
} catch {
  fail("secret key is not a valid Ed25519 keypair");
}
const address = keypair.publicKey.toBase58();

const expected = process.env.TREASURY_WALLET_ADDRESS;
if (expected && expected !== address) {
  fail(`this key belongs to ${address}, not TREASURY_WALLET_ADDRESS ${expected}`);
}

// Import as JWK for EdDSA signing (same shape as src/x402/middleware.ts)
const privateKey = crypto.createPrivateKey({
  key: {
    kty: "OKP",
    crv: "Ed25519",
    d: Buffer.from(secretKey.subarray(0, 32)).toString("base64url"),
    x: Buffer.from(secretKey.subarray(32)).toString("base64url"),
  },
  format: "jwk",
});
const message = new TextEncoder().encode(origin);
const signature = crypto.sign(null, message, privateKey);

// Check it the way x402scan will: against the address, not the private key.
const publicKey = crypto.createPublicKey({
  key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url") },
  format: "jwk",
});
if (!crypto.verify(null, message, publicKey, signature)) fail("signature did not verify; nothing printed");

// stdout: the value to set
process.stdout.write(base58.encode(signature) + "\n");

// stderr: human guidance (won't pollute the value if piped)
process.stderr.write(
  `\nSigned origin ${origin} with ${address}.\n` +
    "Set the base58 line above as X402_OWNERSHIP_PROOF (Railway → Variables).\n" +
    (expected ? "" : "TREASURY_WALLET_ADDRESS was not set, so the address was not checked against it.\n"),
);
