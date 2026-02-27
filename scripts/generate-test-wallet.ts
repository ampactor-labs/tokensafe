#!/usr/bin/env tsx
/**
 * Generate a Solana test wallet for x402 payment testing.
 * Prints the public address and base58-encoded SVM_PRIVATE_KEY.
 * No Solana CLI required — uses @solana/web3.js Keypair.
 */

import { Keypair } from "@solana/web3.js";
import { base58 } from "@scure/base";

const keypair = Keypair.generate();
const address = keypair.publicKey.toBase58();
const svmPrivateKey = base58.encode(keypair.secretKey);

console.log(`Address:         ${address}`);
console.log(`SVM_PRIVATE_KEY: ${svmPrivateKey}`);
console.log();
console.log("Next steps:");
console.log(
  `  1. Fund with devnet SOL:  https://faucet.solana.com  (paste address above)`,
);
console.log(
  `  2. Fund with devnet USDC: https://faucet.circle.com  (select Solana Devnet)`,
);
console.log(`  3. Run the test client:`);
console.log(`     SVM_PRIVATE_KEY=${svmPrivateKey} npm run test:x402`);
