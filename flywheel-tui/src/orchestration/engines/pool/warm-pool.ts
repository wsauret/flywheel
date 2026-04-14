import type { SpawnResult } from "../subprocess/spawner.js";
import {
  killProcessGroup,
  type ChildHandle,
} from "../subprocess/process-lifecycle.js";
import { Log } from "../../../infra/log.js";

// Generic justified: used with both SpawnResult (dispatcher/evaluator) and
// RawSpawnedProcess (subprocess) in create-warm-pools.ts.
interface WarmPoolOptions<T = SpawnResult> {
  spawn: () => Promise<T>;
  label: string;
  getPid?: (proc: T) => number | undefined;
  getExitPromise?: (proc: T) => Promise<unknown>;
  killProc?: (proc: T) => void;
}

export class WarmPool<T = SpawnResult> {
  private readonly spawnFactory: () => Promise<T>;
  private readonly label: string;
  private readonly log = Log.create({ service: "warm-pool" });
  private readonly getPidFn: (proc: T) => number | undefined;
  private readonly getExitPromiseFn: (proc: T) => Promise<unknown>;
  private readonly killProcFn?: (proc: T) => void;

  private warmPromise: Promise<T> | null = null;
  private acquired = false;
  private shuttingDown = false;
  private warmProcessExited = false;

  constructor(options: WarmPoolOptions<T>) {
    this.spawnFactory = options.spawn;
    this.label = options.label;
    this.getPidFn = options.getPid ?? ((proc) => (proc as unknown as SpawnResult).pid);
    this.getExitPromiseFn = options.getExitPromise ?? ((proc) => (proc as unknown as SpawnResult).result);
    this.killProcFn = options.killProc;

    this.spawnWarm();
  }

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

  release(proc: T): void {
    this.acquired = false;
    this.killProcess(proc);

    if (!this.shuttingDown) {
      this.spawnWarm();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.warmPromise) {
      try {
        const proc = await this.warmPromise;
        this.killProcess(proc);
      } catch {
        // Spawn may have failed — nothing to kill
      }
      this.warmPromise = null;
    }
  }

  private spawnWarm() {
    if (this.shuttingDown) return;

    this.warmProcessExited = false;

    this.warmPromise = this.spawnFactory().then((resource) => {
      if (this.shuttingDown) {
        this.killProcess(resource);
        throw new Error("Pool shut down during spawn");
      }

      this.watchForUnexpectedExit(resource);

      const pid = this.getPidFn(resource);
      this.log.debug(`[${this.label}] warm process ready (pid=${pid})`);
      return resource;
    });
  }

  private watchForUnexpectedExit(resource: T) {
    const pid = this.getPidFn(resource);
    const onExit = () => {
      this.warmProcessExited = true;

      if (!this.acquired && !this.shuttingDown) {
        this.log.debug(
          `[${this.label}] warm process died unexpectedly (pid=${pid}), re-spawning`,
        );
        this.spawnWarm();
      }
    };

    this.getExitPromiseFn(resource).then(onExit, onExit);
  }

  private killProcess(proc: T) {
    const pid = this.getPidFn(proc);
    if (pid == null) return;

    if (this.warmProcessExited) {
      this.warmProcessExited = false;
      return;
    }

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
