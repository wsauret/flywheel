import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { maintainSkillLifecycleIfAdmitted } from "../../../../src/orchestration/modules/learning/maintenance.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runRuntimeMaintenanceLifecycle, runSerializedMaintenanceSteps } from "../../../../src/orchestration/app-service/runtime-maintenance-worker.js";
import { pruneRetiredFactFamilies } from "../../../../src/orchestration/session/event-store-maintenance.js";
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { canonicalTestDirectory } from "../../../helpers/directories.js";
import { withEventStore } from "../../../../src/infra/with-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function isPending(promise: Promise<void>): Promise<boolean> {
  const marker = Symbol("pending");
  return await Promise.race([promise.then(() => false), Promise.resolve(marker)]) === marker;
}

describe("maintenance Worker lifecycle", () => {
  test("normal completion waits for cleanup settlement and closes launcher before the log", async () => {
    const cleanup = gate();
    const order: string[] = [];
    const completed = runRuntimeMaintenanceLifecycle({
      lifetime: new AbortController().signal,
      work: async () => { order.push("work"); await cleanup.promise; order.push("cleanup-settled"); },
      closeLauncher: async () => { order.push("launcher-close"); },
      logOwnershipClosed: () => { order.push("closure-log"); },
      closeLog: async () => { order.push("log-close"); },
      exit: () => { order.push("exit"); },
      reportFailure: () => {},
    });

    await Promise.resolve();
    expect(await isPending(completed)).toBe(true);
    expect(order).toEqual(["work"]);
    cleanup.release();
    await completed;
    expect(order).toEqual(["work", "cleanup-settled", "launcher-close", "closure-log", "log-close", "exit"]);
  });

  test("an ended lifetime aborts the work, and settlement waits for its delayed finally without reporting a failure", async () => {
    const finallyGate = gate();
    const abortObserved = gate();
    const lifetime = new AbortController();
    const order: string[] = [];
    const failures: string[] = [];
    const completed = runRuntimeMaintenanceLifecycle({
      lifetime: lifetime.signal,
      work: async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { abortObserved.release(); resolve(); }, { once: true }));
        try { await finallyGate.promise; } finally { order.push("child-finally"); }
        signal.throwIfAborted();
      },
      closeLauncher: async () => { order.push("launcher-close"); },
      logOwnershipClosed: () => { order.push("closure-log"); },
      closeLog: async () => { order.push("log-close"); },
      exit: () => { order.push("exit"); },
      reportFailure: (stage) => { failures.push(stage); },
    });

    await Promise.resolve();
    lifetime.abort(new DOMException("the owner ended the generation", "AbortError"));
    await abortObserved.promise;
    expect(await isPending(completed)).toBe(true);
    expect(order).toEqual([]);
    finallyGate.release();
    await completed;
    expect(order).toEqual(["child-finally", "launcher-close", "closure-log", "log-close", "exit"]);
    // A withdrawn job is its owner's decision, not a failure.
    expect(failures).toEqual([]);
  });

  test("work and launcher-close failures are contained while every owned cleanup runs once", async () => {
    const calls = { launcher: 0, log: 0, exit: 0 };
    const failures: string[] = [];
    await runRuntimeMaintenanceLifecycle({
      lifetime: new AbortController().signal,
      work: async () => { throw new Error("cleanup failed"); },
      closeLauncher: async () => { calls.launcher++; throw new Error("launcher close failed"); },
      logOwnershipClosed: () => {},
      closeLog: async () => { calls.log++; },
      exit: () => { calls.exit++; },
      reportFailure: (stage, error) => { failures.push(`${stage}: ${String(error)}`); },
    });

    expect(calls).toEqual({ launcher: 1, log: 1, exit: 1 });
    expect(failures).toEqual([
      "work: Error: cleanup failed",
      "launcher: Error: launcher close failed",
    ]);
  });
});

describe("serialized maintenance cancellation", () => {
  test("does not enter the next synchronous store step after cancellation", async () => {
    const controller = new AbortController();
    const calls: string[] = [];

    await expect(runSerializedMaintenanceSteps(controller.signal, [
      async () => { calls.push("before"); controller.abort(new Error("released")); },
      () => { calls.push("store"); },
    ])).rejects.toThrow("released");

    expect(calls).toEqual(["before"]);
  });
});

/** One project with its own account data root, so the capability selection this
 *  case states is the only one the maintenance thread can read. */
function workspace(features: string) {
  const home = canonicalTestDirectory(mkdtempSync(join(tmpdir(), "flywheel-maintenance-")));
  created.push(home);
  const projectRoot = join(home, "project");
  const userDataRoot = join(home, ".flywheel");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userDataRoot, { recursive: true });
  writeFileSync(join(userDataRoot, "flywheel.toml"), `features = ${features}\n`);
  return { projectRoot, executionCwd: projectRoot, userDataRoot, accountHome: home };
}

/** The lifecycle pass over the project's own store, as the maintenance
 *  Worker hands it a reader and the writer its facts reach. */
function maintainLifecycle(directories: ReturnType<typeof workspace>, signal = new AbortController().signal) {
  return withEventStore(directories.projectRoot, (store) => maintainSkillLifecycleIfAdmitted({ directories, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), signal }));
}

describe("startup maintenance under capability policy", () => {
  test("archive publication retains its fact writer until the durable audit settles", async () => {
    const directories = workspace('["skills", "learning"]');
    const prepared = prepareWorkspaceState(directories);
    const skillDirectory = join(directories.projectRoot, ".flywheel", "skills", "ancient");
    mkdirSync(skillDirectory, { recursive: true });
    const skillFile = join(skillDirectory, "SKILL.md");
    writeFileSync(skillFile, '---\ndescription: "Use for ancient work."\nmanaged: flywheel\n---\n# Ancient\nBody.\n');
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    utimesSync(skillFile, old, old);
    try {
      expect(await maintainLifecycle(directories)).toEqual({ ran: true });
      expect(existsSync(skillDirectory)).toBe(false);
      expect(existsSync(join(directories.projectRoot, ".flywheel", "skills", ".archive", "ancient"))).toBe(true);
      const store = createSqliteEventStore(resolveEventStoreDbFile(directories.projectRoot));
      try {
        const audits = store.read({ aggregateId: "session:skill-pruner", types: ["skill.written"] });
        expect(audits).toHaveLength(1);
        expect(audits[0]?.payload).toMatchObject({ action: "archived", name: "ancient" });
      } finally {
        store.close();
      }
    } finally {
      prepared.generation.release();
    }
  });

  test("a cancelled maintenance lifetime starts no optional lifecycle work", async () => {
    const directories = workspace('["skills", "learning"]');
    const controller = new AbortController();
    controller.abort(new Error("maintenance cancelled"));
    await expect(maintainLifecycle(directories, controller.signal)).rejects.toThrow("maintenance cancelled");
  });

  test("runs skill lifecycle maintenance while Skills and Learning are enabled", async () => {
    const directories = workspace('["skills", "learning"]');
    const prepared = prepareWorkspaceState(directories);
    try {
      expect(await maintainLifecycle(directories)).toEqual({ ran: true });
    } finally {
      prepared.generation.release();
    }
  });

  test("suppresses skill lifecycle maintenance while Skills is off", async () => {
    const directories = workspace('["learning"]');
    const prepared = prepareWorkspaceState(directories);
    try {
      const lifecycle = await maintainLifecycle(directories);

      expect(lifecycle.ran).toBe(false);
      expect(lifecycle.reason).toContain("skills");
    } finally {
      prepared.generation.release();
    }
  });

  test("suppresses skill lifecycle maintenance while Learning is off, and leaves telemetry maintenance working", async () => {
    const directories = workspace('["skills"]');
    const prepared = prepareWorkspaceState(directories);
    try {
      const lifecycle = await maintainLifecycle(directories);

      expect(lifecycle.ran).toBe(false);
      expect(lifecycle.reason).toContain("learning");

      // Retired-family pruning is core workspace upkeep, not an optional
      // capability, so the same thread still performs it.
      const prune = await pruneRetiredFactFamilies(resolveEventStoreDbFile(directories.projectRoot));
      expect(prune.rowsDeleted).toBe(0);
    } finally {
      prepared.generation.release();
    }
  });

  test("suppresses skill lifecycle maintenance for the Minimal selection", async () => {
    const directories = workspace("[]");
    const prepared = prepareWorkspaceState(directories);
    try {
      expect((await maintainLifecycle(directories)).ran).toBe(false);
    } finally {
      prepared.generation.release();
    }
  });
});
