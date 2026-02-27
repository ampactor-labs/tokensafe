import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { getConnection, initBackupRpc } from "./solana/rpc.js";

// Initialize backup RPC if configured
initBackupRpc();

// Pre-flight health check (non-blocking — degraded is better than no-start)
getConnection()
  .getSlot()
  .then((slot) => logger.info({ slot }, "RPC connectivity verified"))
  .catch((err) => logger.warn({ err }, "RPC pre-flight check failed — starting in degraded mode"));

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, network: config.solanaNetwork },
    "TokenSafe started",
  );
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, draining connections");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 30_000);
});
