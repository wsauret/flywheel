/**
 * WarmPool<T> — manages a single pre-spawned resource for fast acquire.
 *
 * Pool size is always 1. The warm resource is spawned immediately on
 * construction. `acquire()` returns the warm resource (or blocks until
 * it finishes spawning). `release()` kills the resource and spawns a
 * replacement in the background.
 *
 * Generic over the resource type. For `SpawnResult` (dispatcher/evaluator)
 * the pool registers processes and watches for unexpected exits. For
 * `RawSpawnedProcess` (worker) the pool manages raw process handles.
 */

import type { SpawnResult } from "../subprocess/spawner.js";
import {
  registerProcess,
  killProcessGroup,
  type ChildHandle,
} from "../subprocess/process-lifecycle.js";
import { Log } from "../../../infra/log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WarmPoolOptions<T = SpawnResult> {
  /** Factory that produces a new resource. Injected for DI / testability. */
  spawn: () => Promise<T>;
  /** Human-readable label for logging (e.g. "dispatcher", "evaluator", "worker"). */
  label: string;
  /**
   * Extract the PID from the resource. Required for process registry and kill.
   * Defaults to `(proc) => (proc as any).pid` which works for SpawnResult.
   */
  getPid?: (proc: T) => number | undefined;
  /**
   * Extract the exit promise from the resource. Used to watch for unexpected
   * exits. Defaults to `(proc) => (proc as any).result` which works for SpawnResult.
   */
  getExitPromise?: (proc: T) => Promise<unknown>;
  /**
   * Custom kill function for the resource. When not provided, the pool uses
   * `killProcessGroup` with `process.kill()` (works for SpawnResult).
   */
  killProc?: (proc: T) => void;
}

// ---------------------------------------------------------------------------
// WarmPool
// ---------------------------------------------------------------------------

export class WarmPool<T = SpawnResult> {
  private readonly spawnFactory: () => Promise<T>;
  private readonly label: string;
  private readonly log = Log.create({ service: "warm-pool" });
  private readonly getPidFn: (proc: T) => number | undefined;
  private readonly getExitPromiseFn: (proc: T) => Promise<unknown>;
  private readonly killProcFn?: (proc: T) => void;

  /** The promise that resolves to the current warm resource. */
  private warmPromise: Promise<T> | null = null;

  /** Set to true once a resource has been acquired (not yet released). */
  private acquired = false;

  /** Set to true once shutdown() has been called. Prevents further spawns. */
  private shuttingDown = false;

  /** Unregister function for the current warm process in the global registry. */
  private unregister: (() => void) | null = null;

  /** Track whether the warm process has already exited. */
  private warmProcessExited = false;

  constructor(options: WarmPoolOptions<T>) {
    this.spawnFactory = options.spawn;
    this.label = options.label;
    this.getPidFn = options.getPid ?? ((proc) => (proc as unknown as SpawnResult).pid);
    this.getExitPromiseFn = options.getExitPromise ?? ((proc) => (proc as unknown as SpawnResult).result);
    this.killProcFn = options.killProc;

    // Pre-warm immediately
    this.spawnWarm();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Returns the warm resource. If the pool is still warming, blocks until
   * the spawn completes. Throws if the pool is shut down or if a resource
   * is already acquired and not yet released.
   */
  acquire(): Promise<T> {
    if (this.shuttingDown) {
      throw new Error(`[${this.label}] WarmPool is shut down`);
    }
    if (this.acquired) {
      throw new Error(`[${this.label}] No warm process available — already acquired`);
    }
    if (!this.warmPromise) {
      throw new Error(`[${this.label}] No warm process available`);
    }

    this.acquired = true;
    const promise = this.warmPromise;
    this.warmPromise = null;
    return promise;
  }

  /**
   * Release a previously acquired resource. Kills it (SIGTERM) if still
   * alive, then spawns a replacement in the background.
   */
  release(proc: T): void {
    this.acquired = false;
    this.killProcess(proc);

    if (!this.shuttingDown) {
      this.spawnWarm();
    }
  }

  /**
   * Shut down the pool. Kills any warm or in-use resource and prevents
   * future spawns. Returns once cleanup is complete.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Kill the warm resource if one exists
    if (this.warmPromise) {
      try {
        const proc = await this.warmPromise;
        this.killProcess(proc);
      } catch {
        // Spawn may have failed — nothing to kill
      }
      this.warmPromise = null;
    }

    // Unregister any lingering handle
    if (this.unregister) {
      this.unregister();
      this.unregister = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private spawnWarm(): void {
    if (this.shuttingDown) return;

    this.warmProcessExited = false;

    this.warmPromise = this.spawnFactory().then((resource) => {
      if (this.shuttingDown) {
        // Pool was shut down while spawning — kill immediately
        this.killProcess(resource);
        throw new Error("Pool shut down during spawn");
      }

      // Register in the global process registry
      const pid = this.getPidFn(resource);
      if (pid != null) {
        // Unregister previous if somehow still lingering
        if (this.unregister) {
          this.unregister();
        }

        const handle: ChildHandle = {
          pid,
          kill: (signal?: number) => {
            // Use killProcessGroup for proper cleanup
            const sigName =
              signal === 9 ? "SIGKILL" : "SIGTERM";
            killProcessGroup(handle, sigName);
          },
        };
        this.unregister = registerProcess(handle);
      }

      // Watch for unexpected exit while idle (not acquired)
      this.watchForUnexpectedExit(resource);

      this.log.debug(`[${this.label}] warm process ready (pid=${pid})`);
      return resource;
    });
  }

  /**
   * Attach a handler to the resource's exit promise. If it resolves/rejects
   * while the resource is still in the warm slot (not acquired), it means the
   * process died unexpectedly — trigger a re-spawn.
   */
  private watchForUnexpectedExit(resource: T): void {
    const pid = this.getPidFn(resource);
    const onExit = () => {
      this.warmProcessExited = true;

      // Unregister from global registry
      if (this.unregister) {
        this.unregister();
        this.unregister = null;
      }

      // Only re-spawn if the resource is still the warm resource (not acquired)
      if (!this.acquired && !this.shuttingDown) {
        this.log.debug(
          `[${this.label}] warm process died unexpectedly (pid=${pid}), re-spawning`,
        );
        this.spawnWarm();
      }
    };

    this.getExitPromiseFn(resource).then(onExit, onExit);
  }

  /**
   * Kill a resource if it is still alive. Uses SIGTERM via killProcessGroup.
   * If the process has already exited, this is a no-op.
   */
  private killProcess(proc: T): void {
    // Unregister from global registry
    if (this.unregister) {
      this.unregister();
      this.unregister = null;
    }

    const pid = this.getPidFn(proc);
    if (pid == null) return;

    // Check if process already exited — just skip the kill
    if (this.warmProcessExited) {
      this.warmProcessExited = false;
      return;
    }

    // Use custom kill if provided
    if (this.killProcFn) {
      try {
        this.killProcFn(proc);
      } catch {
        // Process may already be dead
      }
      return;
    }

    const handle: ChildHandle = {
      pid,
      kill: (signal?: number) => {
        try {
          process.kill(pid, signal ?? 15);
        } catch {
          // Process already dead
        }
      },
    };

    try {
      killProcessGroup(handle, "SIGTERM");
    } catch {
      // Process may already be dead
    }
  }
}
