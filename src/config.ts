import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const solanaNetwork = (process.env.SOLANA_NETWORK || "devnet") as
  | "mainnet"
  | "devnet";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  treasuryWallet: required("TREASURY_WALLET_ADDRESS"),
  heliusApiKey: required("HELIUS_API_KEY"),
  facilitatorUrl:
    process.env.FACILITATOR_URL || "https://facilitator.payai.network",
  solanaNetwork,
  heliusRpcUrl:
    solanaNetwork === "mainnet"
      ? `https://mainnet.helius-rpc.com/?api-key=${required("HELIUS_API_KEY")}`
      : `https://devnet.helius-rpc.com/?api-key=${required("HELIUS_API_KEY")}`,
  networkCaip2:
    solanaNetwork === "mainnet"
      ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
      : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;
