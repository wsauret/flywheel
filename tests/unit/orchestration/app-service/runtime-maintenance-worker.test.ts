import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js";
import { maintainSkillLifecycleIfAdmitted } from "../../../../src/orchestration/modules/learning/maintenance/maintenance.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DebugLog, type DebugLogRecordInput } from "../../../../src/infra/debug-log.js";
import { createMessagePortProcessEndpoint } from "../../../../src/infra/internal-process-channel.js";
import type { GuardianControl } from "../../../../src/infra/process-supervisor.js";
import { createMaintenanceQueue } from "../../../../src/orchestration/app-service/runtime-maintenance-owner.js";
import { serveProjectStateChannel } from "../../../../src/orchestration/app-service/project-state-channel.js";
import { servedProjectState } from "./_served-project-state-fixture.js";
import { pruneRetiredFactFamilies, type StoreUsage } from "../../../../src/orchestration/session/event-store-maintenance.js";
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js";
import { canonicalTestDirectory } from "../../../helpers/directories.js";
import { withEventStore } from "../../../../src/infra/with-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import { Database } from "bun:sqlite";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A guardian that declares a generation and proves it empty on close; the
 *  job under test launches no process. */
const idleGuardian: Pick<GuardianControl, "openGeneration"> = {
  openGeneration: async () => ({
    request: async () => { throw new Error("this generation leases nothing") },
    pid: async () => process.pid,
    close: async () => ({ settled: true as const }),
  }),
};

const WORKER_URL = new URL("../../../../src/orchestration/app-service/worker-entry.ts", import.meta.url).href;
// The maintenance Worker loads the runtime module graph in a fresh isolate,
// which can take over 5 s on a loaded runner, so each Worker test owns its
// deadline.
const WORKER_BOOT_TEST_TIMEOUT_MS = 60_000;

/** A prepared project whose state is served on this thread to the job's
 *  state channel. `holdCheckpoints` holds the job's first step until the case
 *  releases it. `requests` lists the maintenance requests that reach the
 *  writer, in order. */
function maintainedProject(holdCheckpoints: Promise<void>, kind: "startup" | "idle-reclaim" = "startup") {
  const directories = workspace("[]");
  const checkpointsEntered = Promise.withResolvers<void>();
  const project = servedProjectState(directories, {
    maintenance: {
      enterCheckpointPage: () => {
        checkpointsEntered.resolve();
        return holdCheckpoints;
      },
    },
  });
  const served = { opened: 0, stopped: 0 };
  const reported: StoreUsage[] = [];
  const planned: { [eventType: string]: number } = {};
  const job = {
    kind,
    directories,
    onUsage: (usage: StoreUsage) => { reported.push(usage) },
    onPlanned: (eventType: string, through: number) => { planned[eventType] = through },
    serveState: (port: MessagePort) => {
      served.opened++;
      const stop = serveProjectStateChannel(project.state, createMessagePortProcessEndpoint({ port, decode: (value) => value }), { kind: "maintenance", projectId: directories.projectRoot });
      return async () => { await stop(); served.stopped++; };
    },
  };
  return {
    job, served, reported, planned, store: project.store, checkpointsEntered: checkpointsEntered.promise,
    get requests() { return project.requests.filter((request) => request.startsWith("maintenance.")); },
    close: project.close,
  };
}

/** The records the maintenance Worker forwarded to its owner while `run` ran. */
async function forwardedRecords(run: () => Promise<void>): Promise<readonly DebugLogRecordInput[]> {
  const records: DebugLogRecordInput[] = [];
  const record = spyOn(DebugLog, "record").mockImplementation((input) => { records.push(input); });
  try {
    await run();
  } finally {
    record.mockRestore();
  }
  return records;
}

const payloadOf = (record: DebugLogRecordInput): { readonly [field: string]: unknown } =>
  typeof record.payload === "object" && record.payload !== null ? Object.fromEntries(Object.entries(record.payload)) : {};
const messages = (records: readonly DebugLogRecordInput[]): readonly unknown[] => records.map((record) => payloadOf(record).message);
const workFailures = (records: readonly DebugLogRecordInput[]) =>
  records.filter((record) => payloadOf(record).message === "startup maintenance settlement failed" && payloadOf(record).stage === "work");

describe("the idle reclaim job", () => {
  test("deletes superseded rows through the writer in bounded steps, records one run, and reports the store's usage with the planned superseded bytes", async () => {
    const project = maintainedProject(Promise.resolve(), "idle-reclaim");
    for (const output of ["tail", "settled"]) {
      await project.store.append({ aggregateId: "session:s", type: "tool.execution_output.recorded", version: 1, timestamp: 1, actor: "flywheel", sessionId: "s", payload: { toolUseId: "call", output } });
    }
    const db = new Database(resolveEventStoreDbFile(project.job.directories.projectRoot), { readonly: true });
    const tailBytes = db.query<{ bytes: number }, []>("select length(payload) as bytes from event order by position limit 1").get()!.bytes;
    db.close();
    const maintenance = createMaintenanceQueue({ workerUrl: WORKER_URL, guardian: idleGuardian });
    try {
      const records = await forwardedRecords(async () => {
        const handle = maintenance.project(project.job);
        handle.admit();
        await handle.settled;
        await maintenance.dispose();
      });
      expect(project.requests).toEqual(["maintenance.prune-superseded", "maintenance.incremental-vacuum"]);
      expect(project.store.read({}).map((fact) => fact.payload)).toEqual([{ toolUseId: "call", output: "settled" }]);
      expect(messages(records).filter((message) => message === "idle store reclaim done")).toHaveLength(1);
      // The plan's bytes as soon as it is read, then none once its family is
      // deleted, and the job's closing read.
      expect(project.reported.map((usage) => usage.supersededBytes)).toEqual([tailBytes, 0, 0]);
      expect(project.reported[0]?.reclaimableBytes).toBeGreaterThanOrEqual(tailBytes);
      expect(project.reported[0]?.storeBytes).toBeGreaterThan(0);
      // The owner keeps where each family was planned through, so the next run plans only what landed since.
      expect(project.planned["tool.execution_output.recorded"]).toBe(Math.max(...project.store.read({}).map((fact) => fact.position)));
    } finally {
      await project.close();
    }
  }, WORKER_BOOT_TEST_TIMEOUT_MS);
});

describe("the startup maintenance job", () => {
  test("Maintenance steps run one at a time in order", async () => {
    const hold = Promise.withResolvers<void>();
    const project = maintainedProject(hold.promise);
    const maintenance = createMaintenanceQueue({ workerUrl: WORKER_URL, guardian: idleGuardian });
    try {
      const records = await forwardedRecords(async () => {
        maintenance.project(project.job).admit();
        await project.checkpointsEntered;
        // A step that has not settled holds every later step and the job.
        let settled = false;
        const disposal = maintenance.dispose().then(() => { settled = true; });
        await Bun.sleep(20);
        expect(project.requests).toEqual(["maintenance.finalized-checkpoints"]);
        expect(settled).toBe(false);
        hold.resolve();
        await disposal;
      });
      expect(project.requests.slice(0, 2)).toEqual(["maintenance.finalized-checkpoints", "maintenance.drop-retired-indexes"]);
      const done = messages(records);
      expect(done.indexOf("startup event-store maintenance done")).toBeGreaterThanOrEqual(0);
      expect(done.indexOf("startup event-store maintenance done")).toBeLessThan(done.indexOf("idle scratch sweep done"));
      expect(done).not.toContain("startup maintenance settlement failed");
      expect(project.served).toEqual({ opened: 1, stopped: 1 });
    } finally {
      hold.resolve();
      await project.close();
    }
  }, WORKER_BOOT_TEST_TIMEOUT_MS);

  test("a job withdrawn during a step runs no later step and reports no failure", async () => {
    const hold = Promise.withResolvers<void>();
    const project = maintainedProject(hold.promise);
    const maintenance = createMaintenanceQueue({ workerUrl: WORKER_URL, guardian: idleGuardian });
    try {
      const records = await forwardedRecords(async () => {
        const handle = maintenance.project(project.job);
        handle.admit();
        await project.checkpointsEntered;
        const withdrawn = handle.withdraw();
        hold.resolve();
        await withdrawn;
        await maintenance.dispose();
      });
      expect(project.requests).toEqual(["maintenance.finalized-checkpoints"]);
      expect(messages(records)).not.toContain("startup event-store maintenance done");
      expect(workFailures(records)).toEqual([]);
      expect(project.served).toEqual({ opened: 1, stopped: 1 });
    } finally {
      hold.resolve();
      await project.close();
    }
  }, WORKER_BOOT_TEST_TIMEOUT_MS);
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
