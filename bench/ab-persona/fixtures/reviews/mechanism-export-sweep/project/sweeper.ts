import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { EXPORT_SUFFIX } from "./writer.ts";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Delete finished exports older than `maxAgeMs`. Returns how many it deleted.
 *  A file that cannot be checked or deleted goes to `onError`, and the sweep
 *  continues with the next file. */
export async function sweepOnce(directory: string, maxAgeMs: number, now: number, onError: (error: unknown) => void): Promise<number> {
  let deleted = 0;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(EXPORT_SUFFIX)) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs <= maxAgeMs) continue;
      await unlink(path);
      deleted++;
    } catch (error) {
      if (!isMissing(error)) onError(error);
    }
  }
  return deleted;
}

export interface Sweeper {
  stop(): void;
}

/** Sweep now and then every `intervalMs`, measured from the end of each sweep. */
export function startSweeper(
  directory: string,
  maxAgeMs: number,
  intervalMs: number,
  onSwept: (deleted: number) => void,
  onError: (error: unknown) => void,
): Sweeper {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      onSwept(await sweepOnce(directory, maxAgeMs, Date.now(), onError));
    } catch (error) {
      onError(error);
    } finally {
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  };
  void run();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
