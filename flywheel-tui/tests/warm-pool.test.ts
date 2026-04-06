import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { WarmPool } from "../src/orchestration/engines/pool/warm-pool";
import type { SpawnResult } from "../src/orchestration/engines/subprocess/spawner";
import type { RawSpawnedProcess } from "../src/orchestration/engines/subprocess/stream-pipeline";
import { activeProcesses } from "../src/orchestration/engines/subprocess/process-lifecycle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockProcess {
  spawnResult: SpawnResult;
  /** Resolve the result promise (simulate process exit) */
  exit: (exitCode?: number) => void;
  /** Reject the result promise (simulate unexpected crash) */
  crash: (err?: Error) => void;
  killed: boolean;
}

function createMockProcess(pid: number): MockProcess {
  let resolveResult!: (v: import("../src/orchestration/engines/subprocess/schemas").SubprocessResult) => void;
  let rejectResult!: (e: Error) => void;
  const mockProc: MockProcess = {
    killed: false,
    spawnResult: null as unknown as SpawnResult,
    exit: (exitCode = 0) =>
      resolveResult({
        output: "",
        rawOutput: "",
        exitCode,
        truncated: false,
        durationMs: 0,
        handoffPath: "",
      }),
    crash: (err = new Error("unexpected crash")) => rejectResult(err),
  };

  const result = new Promise<import("../src/orchestration/engines/subprocess/schemas").SubprocessResult>(
    (res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    },
  );

  mockProc.spawnResult = {
    result,
    pid,
    stdinHandle: {
      write: () => true,
      close: () => {},
      get isOpen() {
        return !mockProc.killed;
      },
    },
  };

  return mockProc;
}

function createMockSpawner() {
  let nextPid = 1000;
  const processes: MockProcess[] = [];

  const spawner = async (): Promise<SpawnResult> => {
    const proc = createMockProcess(nextPid++);
    processes.push(proc);
    return proc.spawnResult;
  };

  return { spawner, processes: () => processes, lastProcess: () => processes[processes.length - 1] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WarmPool", () => {
  let pool: WarmPool<SpawnResult>;
  let spawner: ReturnType<typeof createMockSpawner>;

  beforeEach(() => {
    spawner = createMockSpawner();
  });

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  test("spawns a process on creation (pre-warm)", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    // Give microtask queue a tick to let the spawn promise resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(spawner.processes().length).toBe(1);
  });

  test("acquire() returns a SpawnResult with stdinHandle and pid", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    const result = await pool.acquire();

    expect(result.stdinHandle).toBeDefined();
    expect(result.stdinHandle!.write("hello")).toBe(true);
    expect(result.pid).toBe(1000);
  });

  test("acquire() blocks until warm process is ready", async () => {
    // Create a spawner that delays
    let resolveSpawn!: (v: SpawnResult) => void;
    let spawnCalled = false;
    const slowSpawner = () => {
      spawnCalled = true;
      return new Promise<SpawnResult>((res) => {
        resolveSpawn = res;
      });
    };

    pool = new WarmPool({ spawn: slowSpawner, label: "test" });

    let acquired = false;
    const acquirePromise = pool.acquire().then((r) => {
      acquired = true;
      return r;
    });

    // Spawn was called but hasn't resolved
    expect(spawnCalled).toBe(true);
    expect(acquired).toBe(false);

    // Now resolve the spawn
    const mockProc = createMockProcess(9999);
    resolveSpawn(mockProc.spawnResult);

    const result = await acquirePromise;
    expect(acquired).toBe(true);
    expect(result.pid).toBe(9999);
  });

  test("release() kills the process and spawns a replacement", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    const proc = await pool.acquire();
    expect(spawner.processes().length).toBe(1);

    pool.release(proc);

    // Give time for replacement spawn
    await new Promise((r) => setTimeout(r, 10));

    // Original process exited (killed), replacement spawned
    expect(spawner.processes().length).toBe(2);
  });

  test("shutdown() kills all processes and resolves", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    // Acquire and release to get a warm replacement going
    const proc = await pool.acquire();
    pool.release(proc);
    await new Promise((r) => setTimeout(r, 10));

    // Now shut down — should resolve cleanly
    await pool.shutdown();

    // Further acquires should throw
    expect(() => pool.acquire()).toThrow();
  });

  test("double acquire throws (pool size = 1)", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    await pool.acquire();

    // Second acquire should throw since the pool is empty
    expect(() => pool.acquire()).toThrow(/no warm process/i);
  });

  test("process that dies unexpectedly triggers re-spawn", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    // Wait for warm process to be ready
    await new Promise((r) => setTimeout(r, 10));
    expect(spawner.processes().length).toBe(1);

    // Kill the warm process unexpectedly (simulate crash)
    spawner.lastProcess().crash();

    // Wait for re-spawn
    await new Promise((r) => setTimeout(r, 50));

    expect(spawner.processes().length).toBe(2);
  });

  test("release() on already-exited process does not corrupt state", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    const proc = await pool.acquire();

    // Process exits before release
    spawner.lastProcess().exit(0);
    await new Promise((r) => setTimeout(r, 10));

    // Release should still work (just spawns fresh, no kill attempt)
    pool.release(proc);
    await new Promise((r) => setTimeout(r, 10));

    // Should have spawned a replacement
    expect(spawner.processes().length).toBe(2);

    // Pool should be usable
    const proc2 = await pool.acquire();
    expect(proc2.pid).toBe(1001);
  });

  test("registerProcess() called on spawn, unregistered on kill", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });

    await new Promise((r) => setTimeout(r, 10));

    // Process should be registered
    const pids = [...activeProcesses].map((p) => p.pid);
    expect(pids).toContain(1000);

    // Acquire and release (kills old, spawns new)
    const proc = await pool.acquire();
    pool.release(proc);

    await new Promise((r) => setTimeout(r, 10));

    // Old process should be unregistered, new one registered
    const pidsAfter = [...activeProcesses].map((p) => p.pid);
    expect(pidsAfter).not.toContain(1000);
    expect(pidsAfter).toContain(1001);
  });

  test("shutdown prevents re-spawning after unexpected death", async () => {
    pool = new WarmPool({ spawn: spawner.spawner, label: "test" });
    await new Promise((r) => setTimeout(r, 10));

    await pool.shutdown();

    // No additional spawns should happen
    const countAfterShutdown = spawner.processes().length;
    await new Promise((r) => setTimeout(r, 50));
    expect(spawner.processes().length).toBe(countAfterShutdown);
  });
});

// ---------------------------------------------------------------------------
// Generic WarmPool<RawSpawnedProcess> tests (worker pool)
// ---------------------------------------------------------------------------

interface MockRawProcess {
  raw: RawSpawnedProcess;
  resolveExit: (code: number) => void;
  rejectExit: (err: Error) => void;
  killed: boolean;
  unregistered: boolean;
}

function createMockRawProcess(pid: number): MockRawProcess {
  let resolveExit!: (code: number) => void;
  let rejectExit!: (err: Error) => void;
  const exitPromise = new Promise<number>((res, rej) => {
    resolveExit = res;
    rejectExit = rej;
  });

  const mock: MockRawProcess = {
    killed: false,
    unregistered: false,
    resolveExit: null!,
    rejectExit: null!,
    raw: {
      proc: {
        pid,
        exited: exitPromise,
        kill: () => { mock.killed = true; },
      },
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      stdinSink: undefined,
      unregister: () => { mock.unregistered = true; },
    },
  };
  mock.resolveExit = resolveExit;
  mock.rejectExit = rejectExit;
  return mock;
}

describe("WarmPool<RawSpawnedProcess> (worker pool)", () => {
  let pool: WarmPool<RawSpawnedProcess>;
  let nextPid = 2000;
  let mocks: MockRawProcess[];

  function createRawSpawner() {
    mocks = [];
    return () => {
      const m = createMockRawProcess(nextPid++);
      mocks.push(m);
      return Promise.resolve(m.raw);
    };
  }

  afterEach(async () => {
    if (pool) await pool.shutdown();
  });

  test("spawns on creation and acquire returns RawSpawnedProcess", async () => {
    const spawner = createRawSpawner();
    pool = new WarmPool<RawSpawnedProcess>({
      label: "worker-test",
      spawn: spawner,
      getPid: (raw) => raw.proc.pid,
      getExitPromise: (raw) => raw.proc.exited,
      killProc: (raw) => { raw.unregister(); raw.proc.kill(); },
    });

    const raw = await pool.acquire();
    expect(raw.proc.pid).toBeGreaterThanOrEqual(2000);
    expect(mocks.length).toBe(1);
  });

  test("release kills raw process and spawns replacement", async () => {
    const spawner = createRawSpawner();
    pool = new WarmPool<RawSpawnedProcess>({
      label: "worker-test",
      spawn: spawner,
      getPid: (raw) => raw.proc.pid,
      getExitPromise: (raw) => raw.proc.exited,
      killProc: (raw) => { raw.unregister(); raw.proc.kill(); },
    });

    const raw = await pool.acquire();
    pool.release(raw);

    await new Promise((r) => setTimeout(r, 10));

    // Original process was killed and unregistered
    expect(mocks[0].killed).toBe(true);
    expect(mocks[0].unregistered).toBe(true);

    // Replacement was spawned
    expect(mocks.length).toBe(2);
  });

  test("unexpected exit triggers re-spawn", async () => {
    const spawner = createRawSpawner();
    pool = new WarmPool<RawSpawnedProcess>({
      label: "worker-test",
      spawn: spawner,
      getPid: (raw) => raw.proc.pid,
      getExitPromise: (raw) => raw.proc.exited,
      killProc: (raw) => { raw.unregister(); raw.proc.kill(); },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.length).toBe(1);

    // Simulate unexpected exit
    mocks[0].rejectExit(new Error("crash"));
    await new Promise((r) => setTimeout(r, 50));

    expect(mocks.length).toBe(2);
  });

  test("shutdown cleans up raw process", async () => {
    const spawner = createRawSpawner();
    pool = new WarmPool<RawSpawnedProcess>({
      label: "worker-test",
      spawn: spawner,
      getPid: (raw) => raw.proc.pid,
      getExitPromise: (raw) => raw.proc.exited,
      killProc: (raw) => { raw.unregister(); raw.proc.kill(); },
    });

    await new Promise((r) => setTimeout(r, 10));
    await pool.shutdown();

    expect(mocks[0].killed).toBe(true);
    expect(() => pool.acquire()).toThrow(/shut down/i);
  });
});
