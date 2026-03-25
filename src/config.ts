import { PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
dotenv.config({ quiet: true });

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
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || "60", 10),
  liteRateLimitPerMinute: parseInt(
    process.env.LITE_RATE_LIMIT_PER_MINUTE || "30",
    10,
  ),
  ownershipProof: process.env.X402_OWNERSHIP_PROOF || "",
  webhookAdminBearer: process.env.WEBHOOK_ADMIN_BEARER || "",
  dbPath: process.env.DB_PATH || "data/tokensafe.db",
  maxWebhooksPerToken: parseInt(
    process.env.MAX_WEBHOOKS_PER_TOKEN || "100",
    10,
  ),
  monitorIntervalMs: parseInt(process.env.MONITOR_INTERVAL_MS || "300000", 10),
  proMonthlyLimit: parseInt(process.env.PRO_MONTHLY_LIMIT || "6000", 10),
  proRateLimit: parseInt(process.env.PRO_RATE_LIMIT || "200", 10),
  enterpriseRateLimit: parseInt(process.env.ENTERPRISE_RATE_LIMIT || "600", 10),
  backupRpcUrl: process.env.BACKUP_RPC_URL || "",
} as const;

// Startup validation
try {
  new PublicKey(config.treasuryWallet);
} catch {
  throw new Error(
    `TREASURY_WALLET_ADDRESS is not a valid Solana address: ${config.treasuryWallet}`,
  );
}
if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
for (const [key, val] of Object.entries(config)) {
  if (typeof val === "number" && !Number.isFinite(val)) {
    throw new Error(`Invalid numeric config: ${key}`);
  }
}
