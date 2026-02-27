import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

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
