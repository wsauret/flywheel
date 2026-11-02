import { mkdirSync, watch } from "node:fs";
import { DebugLog } from "../../infra/debug-log.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { createBackgroundLane } from "../../infra/ordered-lane.js";
import type { DefinitionReload } from "../../workflows/definition-registry.js";
import type { SkillStoreRoot } from "../../workflows/skills.js";

const log = Log.create({ service: "definition-root-watcher" });

/** Copying or saving a definition produces a burst of directory events; one
 *  reload after the burst settles is enough. */
const DEBOUNCE_MS = 100;

/** The part of node's watcher this watch uses. */
interface DirectoryWatcher {
  on(event: "error", listener: (error: Error) => void): void;
  unref(): void;
  close(): void;
}

/** What a change under a definition root runs. The owner of the registry supplies
 *  it, so the watch and the registry read the same roots. */
interface DefinitionReloadTarget {
  /** Re-reads the roots and publishes the next revision. */
  readonly reload: () => DefinitionReload;
  /** Optional admitted module work that must settle before reading the next revision. */
  readonly beforeReload?: () => void | Promise<void>;
  /** Fires after the reload, for consumers that snapshot the roster. */
  readonly onReloaded?: () => void | Promise<void>;
}

export interface DefinitionRootWatch {
  /** Names what a change runs. A change observed before this call runs the
   *  target once, right after it. */
  bind: (target: DefinitionReloadTarget) => void;
  /** Runs the target now, in the same order as a watched change, for a writer
   *  in this process that must not wait for the file system to report its own
   *  write. A pending debounced reload is folded into this one. Resolves after
   *  the target's onReloaded settles, with what the reload did, or undefined
   *  when the watch is unbound or disposed and nothing ran. Rejects with the
   *  failure of beforeReload or onReloaded. */
  reloadNow: () => Promise<DefinitionReload | undefined>;
  dispose: () => Promise<void>;
}

export interface DefinitionWatchOptions {
  /** Roots to watch, highest precedence first. An owned root is Flywheel's own
   *  store (the project's and the user's) and is created when absent, so the
   *  first definition installed or written into it is observable. A foreign root is
   *  shared with other harnesses: it is watched when it exists and never
   *  created here, so a shared root that appears mid-session is picked up at
   *  the next start. */
  readonly roots: readonly Pick<SkillStoreRoot, "dir" | "owned">[];
  /** Event coalescing window. Tests shorten it to keep the suite fast. */
  readonly debounceMs?: number;
  /** The directory observer. Tests feed events without a filesystem. */
  readonly watchDirectory?: (dir: string, listener: () => void) => DirectoryWatcher;
}

/** Observe one project's skill and persona roots so a package or persona
 *  becomes available without a restart. The observation
 *  starts here, before the registry loads, so the registry's first load and
 *  the events after it cover every change with no reconciliation pass in
 *  between. The reload is atomic: the registry publishes the next revision or
 *  keeps the last valid one. This watch owns filesystem observation and the
 *  one ordered lane every reload of these roots runs in. */
export function watchDefinitionRoots(options: DefinitionWatchOptions): DefinitionRootWatch {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const watchDirectory = options.watchDirectory ?? ((dir, listener) => watch(dir, { recursive: true }, listener));
  const watchers: DirectoryWatcher[] = [];
  let target: DefinitionReloadTarget | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let changedBeforeBind = false;
  const reloads = createBackgroundLane(log, "definition");
  let disposed = false;

  async function reload(cause: "watch" | "write"): Promise<DefinitionReload | undefined> {
    if (disposed || !target) return undefined;
    await target.beforeReload?.();
    if (disposed) return undefined;
    const outcome = target.reload();
    // A kept revision is already a warning from the registry.
    if (outcome.published) {
      DebugLog.record({ type: "definitions.revision.published", payload: { revision: outcome.revision, skills: outcome.skills, cause } });
    }
    await target.onReloaded?.();
    return outcome;
  }

  function scheduleReload(): void {
    if (disposed) return;
    if (!target) { changedBeforeBind = true; return; }
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      reloads.runInBackground("reload", async () => { await reload("watch"); });
    }, debounceMs);
  }

  for (const root of options.roots.filter(({ owned }) => owned)) {
    try {
      mkdirSync(root.dir, { recursive: true });
    } catch (err) {
      log.debug(`could not create ${root.dir}: ${errorMessage(err)}`);
    }
  }

  for (const { dir } of options.roots) {
    try {
      const watcher = watchDirectory(dir, scheduleReload);
      // A watch that dies mid-session (root removed, descriptor limit) must not
      // reach the process error handler: definitions just stop hot-reloading.
      watcher.on("error", (err) => log.warn(`definition watch failed for ${dir}: ${errorMessage(err)}`));
      // Never hold the event loop open for a watcher; exit must not wait on it.
      watcher.unref();
      watchers.push(watcher);
    } catch (err) {
      // Foreign roots are optional user directories; absence is "nothing to watch".
      log.debug(`not watching ${dir}: ${errorMessage(err)}`);
    }
  }

  return {
    bind(next) {
      if (target) throw new Error("definition root watch is already bound");
      target = next;
      if (changedBeforeBind) scheduleReload();
    },
    reloadNow: async () => {
      if (pending) clearTimeout(pending);
      pending = undefined;
      return await reloads.run(() => reload("write"));
    },
    dispose: async () => {
      disposed = true;
      if (pending) clearTimeout(pending);
      for (const watcher of watchers) watcher.close();
      await reloads.settled();
    },
  };
}
