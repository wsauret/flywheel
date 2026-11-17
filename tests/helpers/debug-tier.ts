import { Log } from "../../src/infra/log.js";

/** Runs `body` with the log at DEBUG, so the debug-tier diagnostic families
 *  reach a destination that discards them, then restores the default level. */
export async function withDebugTier<T>(body: () => Promise<T>): Promise<T> {
  await Log.init({ level: "DEBUG", forward: () => {} });
  try {
    return await body();
  } finally {
    await Log.closeGlobal();
  }
}
