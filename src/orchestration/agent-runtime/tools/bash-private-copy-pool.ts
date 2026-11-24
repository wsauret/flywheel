/**
 * The idle private copies of one session, kept in memory between its
 * mutating commands. A take checks a copy out, so only one command uses it at
 * a time, and refreshes it in place (`takePrivateProjectCopy`). Its landing
 * gives it back only when no process its command started can still write to
 * it. The pool never adopts a copy from disk: a new pool starts empty, and a
 * home no live pool holds is landed by a handover or removed by the sweep.
 * The pool also owns the one private copy Worker that its copies' jobs run on.
 */

import { mayHaveSurvivingDescendant } from "../../../infra/container-mark.js";
import { Log } from "../../../infra/log.js";
import { bunContainerProbe, processStart, type ContainerProbe } from "../../../infra/process-container.js";
import type { RepositoryState } from "./bash-copy-repository-state.js";
import { discardPrivateCopy } from "./bash-private-copy-home.js";
import { createPrivateCopyJobs, type PrivateCopyJobs, type SpawnWorker } from "./bash-private-copy-jobs.js";

const log = Log.create({ service: "bash-private-copy" });

/** How long after its last completed refresh an idle copy can still be
 *  refreshed. A refresh is the copy's last write, and the scratch sweep can
 *  select a recorded home only after three idle days, so the pool never
 *  refreshes a home the sweep may be removing. */
const REUSE_IDLE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** What a copy's home layout depends on. The private Git directory is kept or
 *  seeded again by the real repository's state (`ReusableCopy.git`), so the Git
 *  directories and formats are not part of it. */
export interface CopyGeometry {
  readonly realRoot: string;
  /** The directory name under `tree/`: the Git top level's name, or the real root's outside Git. */
  readonly treeName: string;
  /** The real root below the Git top level; empty at the top level and outside Git. */
  readonly projectInTree: string;
  readonly repository: boolean;
}

/** A taken copy as the next take of its session refreshes it. Memory only. */
export interface ReusableCopy {
  readonly home: string;
  readonly geometry: CopyGeometry;
  /** Whether the home holds a before image of the session folder. The mirror
   *  state of the home's entries stays with the pool's Worker, by home. */
  readonly beforeImage: boolean;
  /** In a repository, the real state the last take seeded the private Git
   *  directory from, and the private state that seed produced. A copy comes
   *  back to its pool only after a landing whose own read of the private state
   *  equalled `baseline`, so the next take of the same real state keeps the
   *  directory and this baseline instead of seeding and reading it again. */
  readonly git?: { readonly fingerprint: string; readonly baseline: RepositoryState };
  /** When the last take of this copy finished, as `Date.now()`. */
  readonly refreshedAt: number;
}

/** The start stamp of the process a command's launch started, read while it
 *  ran, and whether the command ran as the first process of its own process
 *  namespace. */
export interface LaunchStamp {
  readonly start: string;
  readonly pidNamespace: boolean;
}

/** What `release` did: `pooled` kept the copy. Otherwise the caller discards
 *  it, and the value names why: `stamp`, the launch has no proven stamp;
 *  `slot`, the pool already holds a copy of this real root or is closed;
 *  `survivor`, a process the command started may still run. */
export type CopyRelease = "pooled" | "stamp" | "slot" | "survivor";

export interface PrivateCopyPool {
  /** Runs the private copy jobs of every command of this pool's session. */
  readonly jobs: PrivateCopyJobs;
  /** Removes and returns the idle copy of `geometry.realRoot`. A copy of
   *  another geometry, or one whose last refresh is older than
   *  `REUSE_IDLE_LIMIT_MS`, is discarded instead. */
  checkout(geometry: CopyGeometry): ReusableCopy | undefined;
  /** The stamp of `pid`, or nothing when the kernel does not prove it. */
  launchStamp(pid: number, pidNamespace: boolean): LaunchStamp | undefined;
  /** Takes a copy back after its command's `exited` settled and its landing
   *  finished. Never writes to the home; a copy it refuses is the caller's
   *  to discard. */
  release(copy: ReusableCopy, launch: LaunchStamp | undefined): CopyRelease;
  /** Runs the landing of a copy this pool's `jobs` took. An open pool runs its
   *  jobs on the pool's Worker, and `close` waits for it. After `close`, a
   *  command that ended late still lands, on a Worker of its own that ends with
   *  the landing. Answers and rejects as `land` does. */
  landing<T>(land: (jobs: PrivateCopyJobs) => Promise<T>): Promise<T>;
  /** Removes a copy of this pool's commands off the command's critical path
   *  (`discardPrivateCopy`), and `close` waits for the removal. The returned
   *  promise settles when the removal ended; it never rejects. */
  discard(copy: Pick<ReusableCopy, "home">): Promise<void>;
  /** Discards every idle copy, refuses every later release, waits for the
   *  landings in flight and then for every removal started until then, then
   *  refuses every later job of `jobs` and ends the pool's Worker once its
   *  jobs in flight settled. A command that lands after `close` discards its
   *  copy too, and nothing waits for that removal. Never rejects. */
  close(): Promise<void>;
}

/** Creates the pool of one session runner generation. `now`, `probe`, and `spawn` are seams for tests. */
export function createPrivateCopyPool({ now = Date.now, probe = bunContainerProbe, spawn }: { readonly now?: () => number; readonly probe?: ContainerProbe; readonly spawn?: SpawnWorker } = {}): PrivateCopyPool {
  const idle = new Map<string, ReusableCopy>();
  const jobs = createPrivateCopyJobs(spawn);
  const landings = new Set<Promise<unknown>>();
  const removals = new Set<Promise<void>>();
  let closed = false;
  const discard = (copy: Pick<ReusableCopy, "home">): Promise<void> => {
    const removal = discardPrivateCopy(copy.home);
    removals.add(removal);
    void removal.then(() => removals.delete(removal));
    return removal;
  };
  return {
    jobs,
    checkout(geometry) {
      const copy = idle.get(geometry.realRoot);
      if (!copy) return undefined;
      idle.delete(geometry.realRoot);
      const same = copy.geometry.treeName === geometry.treeName && copy.geometry.projectInTree === geometry.projectInTree && copy.geometry.repository === geometry.repository;
      if (same && now() - copy.refreshedAt <= REUSE_IDLE_LIMIT_MS) return copy;
      void discard(copy);
      return undefined;
    },
    launchStamp(pid, pidNamespace) {
      const start = processStart(pid, probe);
      return start.kind === "process" ? { start: start.start, pidNamespace } : undefined;
    },
    release(copy, launch) {
      if (launch === undefined) return "stamp";
      if (closed || idle.has(copy.geometry.realRoot)) return "slot";
      if (mayHaveSurvivingDescendant(launch, probe)) return "survivor";
      idle.set(copy.geometry.realRoot, copy);
      return "pooled";
    },
    async landing(land) {
      if (closed) {
        const own = createPrivateCopyJobs();
        try {
          return await land(own);
        } finally {
          await own.close();
        }
      }
      const landed = land(jobs);
      landings.add(landed);
      try {
        return await landed;
      } finally {
        landings.delete(landed);
      }
    },
    discard,
    async close() {
      closed = true;
      for (const copy of idle.values()) void discard(copy);
      if (idle.size > 0) log.info("idle private copies discarded at close", { count: idle.size });
      idle.clear();
      await Promise.allSettled(landings);
      // A landing discards its copy as it ends, so its removal is in the set by now.
      await Promise.all(removals);
      await jobs.close();
    },
  };
}
