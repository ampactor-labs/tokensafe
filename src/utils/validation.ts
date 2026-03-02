import { PublicKey } from "@solana/web3.js";
import { ApiError } from "./errors.js";

export function validateMint(mint: unknown): asserts mint is string {
  if (typeof mint !== "string" || mint.length === 0 || mint.length > 100) {
    throw new ApiError("INVALID_MINT_ADDRESS", "Invalid mint address");
  }
  try {
    new PublicKey(mint);
  } catch {
    throw new ApiError(
      "INVALID_MINT_ADDRESS",
      `Invalid Solana mint address: ${mint}`,
    );
  }
}
