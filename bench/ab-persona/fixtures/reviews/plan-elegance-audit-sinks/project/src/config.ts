export interface Config {
  readonly port: number;
  readonly dataDir: string;
}

/** Reads the environment once at startup. A bad value stops startup with a message that names the variable. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a TCP port, got "${env.PORT}"`);
  const dataDir = env.DATA_DIR;
  if (dataDir === undefined || dataDir === "") throw new Error("DATA_DIR is required");
  return { port, dataDir };
}
