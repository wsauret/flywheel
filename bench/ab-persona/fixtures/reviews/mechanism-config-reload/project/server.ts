import { readFile } from "node:fs/promises";
import { ConfigStore } from "./config.ts";
import { createHandler } from "./handler.ts";
import { createRateLimiter } from "./limiter.ts";

export async function startServer(configPath: string) {
  const config = new ConfigStore(await readFile(configPath, "utf8"));
  const limiter = createRateLimiter(config, Date.now);
  const handle = createHandler(() => config.current(), limiter);
  config.onChange((next) => {
    console.info(`config applied: ${Object.keys(next.features).length} feature flags`);
  });
  return { config, handle };
}
