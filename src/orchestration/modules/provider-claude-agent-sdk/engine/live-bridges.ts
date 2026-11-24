/** The release of every live engine use of this process when the module turns off: each chat bridge's CLI, each
 *  hosted agent's lease of its host, and the host claims of each shown session. It imports nothing from the Agent
 *  SDK, so the module's service can release them without loading the SDK. */
const uses = new Set<{ readonly release: () => void; readonly resume: (() => void) | undefined }>();

/** Adds the release of one engine use, and its `resume` when the module is on again; the returned function removes
 *  them when that use ends. */
export function registerLiveBridge(release: () => void, resume?: () => void): () => void {
  const use = { release, resume };
  uses.add(use);
  return () => { uses.delete(use); };
}

/** Tells every live engine use of this process to let its engine go: at once when it serves no request, and as soon
 *  as its open request ends otherwise, also a request admitted before the release that reaches its engine after it.
 *  A shared host closes when its last use lets it go. The uses stay open, so a later request starts a new engine. */
export function releaseLiveBridges(): void {
  for (const { release } of uses) release();
}

/** Tells every live engine use of this process that the module is on: a use that still lets its engine go when its
 *  request ends keeps the engine again. */
export function resumeLiveBridges(): void {
  for (const { resume } of uses) resume?.();
}

/** The drain of the process's shared agent hosts, once a client loaded them. The module's service drains them
 *  through it at the process's shutdown without loading the Agent SDK. */
const drains = new Set<() => Promise<void>>();

/** Adds the drain of a host registry. The process's registry adds its own once, when it is made. Returns the
 *  removal. */
export function registerHostDrain(drain: () => Promise<void>): () => void {
  drains.add(drain);
  return () => { drains.delete(drain); };
}

/** Closes every shared agent host of the process at once and waits for the closes. Only the process's shutdown
 *  drains: a module-selection change never cancels admitted work (ARCH-RUNTIME-063). */
export async function drainAgentHosts(): Promise<void> {
  await Promise.all([...drains].map((drain) => drain()));
}
