/**
 * The idle private copies of one session, kept in memory between its
 * mutating commands. A take checks a copy out, so only one command uses it at
 * a time, and refreshes it in place (`takePrivateProjectCopy`). Its landing
 * gives it back only when no process its command started can still write to
 * it. The pool never adopts a copy from disk: a new pool starts empty, and a
 * home no live pool holds is landed by a handover or removed by the sweep.
 */

import { mayHaveSurvivingDescendant } from "../../../infra/container-mark.js";
import { Log } from "../../../infra/log.js";
import { bunContainerProbe, processStart, type ContainerProbe } from "../../../infra/process-container.js";
import { discardPrivateCopy } from "./bash-private-copy.js";
import type { CopyTreeState } from "./bash-private-copy-tree.js";

const log = Log.create({ service: "bash-private-copy" });

/** How long after its last completed refresh an idle copy can still be
 *  refreshed. A refresh is the copy's last write, and the scratch sweep can
 *  select a recorded home only after three idle days, so the pool never
 *  refreshes a home the sweep may be removing. */
export const REUSE_IDLE_LIMIT_MS = 24 * 60 * 60 * 1000;

/** What a copy's home layout depends on. The private Git directory is built
 *  again on every take, so the Git directories and formats are not part of it. */
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
  /** What each mirror of the last take left in the home. */
  readonly state: CopyTreeState;
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
  /** Discards every idle copy and refuses every later release. */
  close(): void;
}

/** Creates the pool of one session runner generation. `now` and `probe` are seams for tests. */
export function createPrivateCopyPool({ now = Date.now, probe = bunContainerProbe }: { readonly now?: () => number; readonly probe?: ContainerProbe } = {}): PrivateCopyPool {
  const idle = new Map<string, ReusableCopy>();
  let closed = false;
  return {
    checkout(geometry) {
      const copy = idle.get(geometry.realRoot);
      if (!copy) return undefined;
      idle.delete(geometry.realRoot);
      const same = copy.geometry.treeName === geometry.treeName && copy.geometry.projectInTree === geometry.projectInTree && copy.geometry.repository === geometry.repository;
      if (same && now() - copy.refreshedAt <= REUSE_IDLE_LIMIT_MS) return copy;
      discardPrivateCopy(copy);
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
    close() {
      closed = true;
      for (const copy of idle.values()) discardPrivateCopy(copy);
      if (idle.size > 0) log.info("idle private copies discarded at close", { count: idle.size });
      idle.clear();
    },
  };
}
