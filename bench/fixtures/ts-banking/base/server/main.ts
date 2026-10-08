// Entry point: `npm start` (or `node server/main.ts`).
//   PORT=8080 DATA_FILE=data/bank.json node server/main.ts

import { join } from "node:path";
import { systemClock } from "../packages/shared/src/clock.ts";
import { randomIds } from "../packages/shared/src/ids.ts";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createDeps } from "./deps.ts";
import { listen } from "./http/server.ts";
import { consoleLogger } from "./logger.ts";

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const deps = createDeps({
    clock: systemClock,
    ids: randomIds,
    dataFile: env["DATA_FILE"] ?? join(process.cwd(), "data", "bank.json"),
    config: configFromEnv(env),
    logger: consoleLogger,
  });
  const app = createApp(deps);
  const server = await listen(app, { port: Number(env["PORT"] ?? 8080), host: env["HOST"] ?? "127.0.0.1" });
  consoleLogger.info(`Quillmoor online banking listening on ${server.url}`);
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  void main();
}
