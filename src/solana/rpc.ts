import { Connection } from "@solana/web3.js";
import { config } from "../config.js";

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.heliusRpcUrl, {
      commitment: "confirmed",
      fetch: (url, init) =>
        fetch(url as string, {
          ...(init as RequestInit),
          signal: AbortSignal.timeout(10_000),
        }),
    });
  }
  return connection;
}
