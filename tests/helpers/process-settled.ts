import type { BackgroundWorkRegistry } from "../../src/orchestration/session/control/background-work/background-work.js";

/** Resolves once the registry records how session process `id` ended: true
 *  for a settled record, false when the registry holds no record of the
 *  process, such as one it never tracked or one another owner took over. */
export function processSettled(tasks: Pick<BackgroundWorkRegistry, "processRecord" | "observeWorkChanges">, id: string): Promise<boolean> {
  const settled = (): boolean | undefined => {
    const status = tasks.processRecord(id)?.status;
    if (status === undefined) return false;
    return status === "running" || status === "stopping" ? undefined : true;
  };
  return new Promise((resolve) => {
    const now = settled();
    if (now !== undefined) {
      resolve(now);
      return;
    }
    const stop = tasks.observeWorkChanges(() => {
      const next = settled();
      if (next === undefined) return;
      stop();
      resolve(next);
    });
  });
}
