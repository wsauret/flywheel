/**
 * Per-attempt concurrency contract for foreground tool execution, with three
 * admission classes (ARCH-TOOLS-004):
 *
 *  - `safe`: may run alongside any number of other safe or path-scoped
 *    calls, capped at `maxConcurrent`.
 *  - `paths`: a mutation call that declares its canonical target paths. It
 *    may run alongside safe calls and other path-scoped calls whose
 *    reservations do not overlap; overlapping targets serialize.
 *  - `exclusive`: runs exclusive of every other call in the attempt -
 *    nothing else starts until it settles, and it waits for whatever is
 *    currently running to drain first.
 *
 * Path-scoped admission: path-scoped tools parallelize when their
 * canonicalized targets are disjoint. Flywheel keeps arrival-order service
 * instead of segment planning: calls are served in arrival order, and a
 * blocked call at the head of the queue blocks later arrivals, so a queued
 * write is never starved by later-arriving reads.
 *
 * This governs same-attempt ordering only. The per-realpath file-mutation
 * queue (`file-mutation-queue.ts`) remains defense in depth for writers
 * outside this gate's scope, e.g. a concurrent subagent runner.
 */

import { sep } from "node:path";

export type GateAdmission =
  | { kind: "none" }
  | { kind: "safe" }
  | { kind: "exclusive" }
  /** Canonical realpaths this call mutates (see canonicalMutationPath in
   *  file-mutation-queue.ts); must be non-empty. */
  | { kind: "paths"; paths: readonly string[] };

interface Waiter {
  admission: GateAdmission;
  resolve: (release: () => void) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ToolConcurrencyGate {
  /** Resolves once this call may run; call the returned function when done. */
  acquire(admission: GateAdmission, signal?: AbortSignal): Promise<() => void>;
}

export function createToolConcurrencyGate(maxConcurrent: number): ToolConcurrencyGate {
  let active = 0;
  let exclusiveActive = false;
  /** Multiset of path reservations held by currently running calls. */
  const heldPaths: string[] = [];
  const queue: Waiter[] = [];

  function admissible(admission: GateAdmission): boolean {
    if (exclusiveActive) return false;
    if (active >= maxConcurrent) return false;
    switch (admission.kind) {
      case "none":
        return true;
      case "safe":
        return true;
      case "exclusive":
        return active === 0;
      case "paths":
        return !admission.paths.some((path) => heldPaths.some((held) => pathsOverlap(path, held)));
    }
  }

  function admit(waiter: Waiter): void {
    waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => {}));
    active++;
    if (waiter.admission.kind === "exclusive") exclusiveActive = true;
    if (waiter.admission.kind === "paths") heldPaths.push(...waiter.admission.paths);
    waiter.resolve(() => release(waiter.admission));
  }

  function pump(): void {
    while (queue.length > 0) {
      // SAFETY: loop guard is queue.length > 0, so index 0 is defined.
      const next = queue[0]!;
      if (!admissible(next.admission)) return;
      queue.shift();
      admit(next);
    }
  }

  function release(admission: GateAdmission): void {
    active--;
    if (admission.kind === "exclusive") exclusiveActive = false;
    if (admission.kind === "paths") {
      for (const path of admission.paths) {
        const index = heldPaths.indexOf(path);
        if (index >= 0) heldPaths.splice(index, 1);
      }
    }
    pump();
  }

  return {
    acquire(admission: GateAdmission, signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (admission.kind === "none") return Promise.resolve(() => {});
      return new Promise((resolve, reject) => {
        const waiter: Waiter = { admission, resolve, reject, signal };
        if (signal !== undefined) {
          waiter.onAbort = () => {
            const index = queue.indexOf(waiter);
            if (index < 0) return;
            queue.splice(index, 1);
            reject(abortError(signal));
            pump();
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        queue.push(waiter);
        pump();
      });
    },
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Tool admission interrupted");
}

/** Subtree overlap on canonical paths: equal, or one prefixes the other on a
 *  separator boundary (a mutation of a directory conflicts with a file inside). */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
