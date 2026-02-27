import pino from "pino";

const nodeEnv = process.env.NODE_ENV || "development";

export const logger = pino({
  level: nodeEnv === "development" ? "debug" : "info",
});
