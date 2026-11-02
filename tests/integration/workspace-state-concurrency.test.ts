/** Two processes over one project's state generation.
 *
 *  A generation is the workspace members of one epoch: the event store, its
 *  sidecars, its rebuildable indexes and their sidecars, and the session and
 *  breadcrumb trees. Retirement moves those
 *  members aside and then deletes them, so it is only ever safe while nobody
 *  holds them open. The invariants that matter are cross-process ones, so every
 *  owner here is a real process: a live owner forbids the retirement and keeps
 *  every member in place, a released owner allows it, a crashed owner never
 *  wedges the gate, two starts that race the same old generation retire it
 *  exactly once, and a start killed anywhere inside the sequence is finished by
 *  the next one. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ProjectDirectories } from "../../src/infra/directory-authorities.js";
import { resolveEventStoreDbFile } from "../../src/infra/paths.js";
import { openWorkspaceState, prepareWorkspaceState } from "../../src/orchestration/workspace-state.js";
import { EVENT_STORE_MEMBER } from "../../src/orchestration/workspace-state-generation-members.js";
import { WORKSPACE_STATE_EPOCH, type RetirementCheckpoint } from "../../src/orchestration/workspace-state-retirement.js";
import { interruptRetirementAt, requireRetiredWorkspace } from "../fixtures/create-retired-workspace.js";
import { testDirectories } from "../helpers/directories.js";
import { WORKSPACE_DATABASE_MEMBERS } from "../helpers/workspace-retirement.js";

const REPO = join(import.meta.dir, "..", "..");
const TMP = join(tmpdir(), `flywheel-workspace-state-concurrency-${randomUUID()}`);
const OLD_EPOCH = 1;
const REFUSAL = "cannot be replaced while another owner holds this project's state generation";

/** Owns the generation the way a normal Flywheel start does, reports that it
 *  holds it, and keeps holding it until it is told to stop. */
const HOLDER = `
import { existsSync } from "node:fs";
import { prepareWorkspaceState } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/workspace-state.js")).href)};

const prepared = prepareWorkspaceState(JSON.parse(process.argv[2]));
await Bun.write(process.argv[3], "");
while (!existsSync(process.argv[4])) await Bun.sleep(2);
prepared.generation.release();
`;

/** One start of the whole preparation, barrier-synchronized with its twin so
 *  both are inside the generation gate's window at the same time. It reports
 *  whether it was the start that retired the old generation, which it reads from
 *  the retirement sequence's own checkpoints: no start returns that. */
const STARTER = `
import { existsSync } from "node:fs";
import { prepareWorkspaceState } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/workspace-state.js")).href)};
import { observeRetirementCheckpoints } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/workspace-state-retirement.js")).href)};

let retired = false;
observeRetirementCheckpoints((checkpoint) => { if (checkpoint === "manifest-published") retired = true; });
while (!existsSync(process.argv[3])) await Bun.sleep(1);
const prepared = prepareWorkspaceState(JSON.parse(process.argv[2]));
console.log(retired ? "retired" : "joined");
prepared.generation.release();
`;

function directories(): ProjectDirectories {
  return testDirectories(TMP);
}

function flywheelDir(): string {
  return join(TMP, ".flywheel");
}

/** A live process that opens the database, writes into a write-ahead log, and
 *  is killed before anything checkpoints it. SQLite deletes both sidecars on a
 *  clean close, so killing the writer is the only way to hold an uncheckpointed
 *  log and its shared-memory index on disk. */
const HOT_WRITER = `
import { Database } from "bun:sqlite";

const db = new Database(process.argv[2]);
db.exec("PRAGMA journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS legacy_fact (id INTEGER PRIMARY KEY, body TEXT)");
db.exec("INSERT INTO legacy_fact (body) VALUES ('a fact that is still only in the log')");
await Bun.write(process.argv[3], "");
while (true) await Bun.sleep(50);
`;

function readEpoch(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db.query<{ user_version?: unknown }, []>("PRAGMA user_version").get();
    return typeof row?.user_version === "number" ? row.user_version : 0;
  } finally {
    db.close();
  }
}

function stampEpoch(dbFile: string, epoch: number): void {
  const db = new Database(dbFile);
  try {
    db.exec(`PRAGMA user_version = ${epoch}`);
  } finally {
    db.close();
  }
}

/** A current workspace nobody owns any more: prepared once, then released, so
 *  the only owners the next start can observe are the ones a test adds. */
function unownedWorkspace(): string {
  const prepared = prepareWorkspaceState(directories());
  prepared.generation.release();
  return prepared.dbFile;
}

/** A workspace of the previous epoch that nobody owns, holding a whole
 *  generation for a retirement to move: a real epoch-1 database, the
 *  uncheckpointed write-ahead log and shared-memory index of a writer that
 *  died, every derived database member, one session tree, and the
 *  agent-output trees of two runners. */
async function unownedLegacyWorkspace(): Promise<string> {
  const dbFile = unownedWorkspace();
  stampEpoch(dbFile, OLD_EPOCH);
  await leaveHotWriteAheadLog(dbFile);
  for (const name of WORKSPACE_DATABASE_MEMBERS) {
    if (!name.startsWith(EVENT_STORE_MEMBER)) writeFileSync(join(flywheelDir(), name), `legacy ${name}`);
  }
  writeUnder(join(flywheelDir(), "sessions", "legacy"), "owner.pid", "1");
  writeUnder(join(flywheelDir(), "agent-outputs", "legacy"), "read_1.txt", "crumb");
  writeUnder(join(flywheelDir(), "agent-outputs", "legacy-subagent"), "search_1.txt", "crumb");
  for (const sidecar of ["-wal", "-shm"]) {
    const size = statSync(`${dbFile}${sidecar}`).size;
    if (size === 0) throw new Error(`the legacy generation needs a nonempty ${sidecar}`);
  }
  return dbFile;
}

async function leaveHotWriteAheadLog(dbFile: string): Promise<void> {
  const ready = join(TMP, "hot-writer-ready");
  const child = Bun.spawn(["bun", writeWorker("hot-writer.ts", HOT_WRITER), dbFile, ready], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  while (!existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(`the hot writer exited early: ${await new Response(child.stderr).text()}`);
    await Bun.sleep(2);
  }
  child.kill("SIGKILL");
  await child.exited;
}

function writeUnder(directory: string, name: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), content);
}

function writeWorker(name: string, source: string): string {
  const script = join(TMP, name);
  writeFileSync(script, source);
  return script;
}

/** A live process that owns the generation, and the handle that stops it. */
async function startHolder(): Promise<{ stop: () => Promise<void> }> {
  const ready = join(TMP, "holder-ready");
  const stopFile = join(TMP, "holder-stop");
  const child = Bun.spawn(["bun", writeWorker("holder.ts", HOLDER), JSON.stringify(directories()), ready, stopFile], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  while (!existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(`holder exited early: ${await new Response(child.stderr).text()}`);
    await Bun.sleep(2);
  }
  return {
    stop: async () => {
      writeFileSync(stopFile, "");
      expect(await child.exited).toBe(0);
    },
  };
}

/** The pid of a process that has certainly exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["bun", "-e", ""], { cwd: REPO, stdout: "ignore", stderr: "ignore", windowsHide: true });
  await child.exited;
  return child.pid;
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("one project's state generation across processes", () => {
  it("refuses to retire an old generation a live process still owns, and moves no member", async () => {
    const holder = await startHolder();
    const dbFile = resolveEventStoreDbFile(TMP);
    stampEpoch(dbFile, OLD_EPOCH);
    const before = readFileSync(dbFile);

    try {
      expect(() => prepareWorkspaceState(directories())).toThrow(REFUSAL);
      expect(readFileSync(dbFile)).toEqual(before);
      expect(readEpoch(dbFile)).toBe(OLD_EPOCH);
      expect(existsSync(join(flywheelDir(), "retiring"))).toBe(false);
    } finally {
      await holder.stop();
    }
  }, 30_000);

  it("retires the same generation once its last owner releases", async () => {
    const holder = await startHolder();
    stampEpoch(resolveEventStoreDbFile(TMP), OLD_EPOCH);
    expect(() => prepareWorkspaceState(directories())).toThrow(REFUSAL);
    await holder.stop();

    const prepared = prepareWorkspaceState(directories());

    try {
      expect(readEpoch(prepared.dbFile)).toBe(WORKSPACE_STATE_EPOCH);
      await requireRetiredWorkspace(TMP);
    } finally {
      prepared.generation.release();
    }
  }, 30_000);

  it("retires a generation whose owner crashed without releasing", async () => {
    await unownedLegacyWorkspace();
    const abandoned = join(flywheelDir(), `project-generation.lock.shared.${randomUUID()}`);
    writeFileSync(abandoned, JSON.stringify({ pid: await deadPid(), owner: "abandoned" }), { mode: 0o600 });

    const prepared = prepareWorkspaceState(directories());

    try {
      await requireRetiredWorkspace(TMP);
      expect(readEpoch(prepared.dbFile)).toBe(WORKSPACE_STATE_EPOCH);
      expect(existsSync(abandoned)).toBe(false);
    } finally {
      prepared.generation.release();
    }
  }, 30_000);

  it("refuses to retire a generation this process still owns", () => {
    const dbFile = unownedWorkspace();
    const owner = prepareWorkspaceState(directories());
    stampEpoch(dbFile, OLD_EPOCH);

    expect(() => prepareWorkspaceState(directories())).toThrow(REFUSAL);
    expect(readEpoch(dbFile)).toBe(OLD_EPOCH);
    owner.generation.release();

    const prepared = prepareWorkspaceState(directories());

    try {
      expect(readEpoch(prepared.dbFile)).toBe(WORKSPACE_STATE_EPOCH);
    } finally {
      prepared.generation.release();
    }
  });


  it("drops obsolete prune evidence only after other owners exit", async () => {
    const dbFile = unownedWorkspace();
    const holder = await startHolder();
    const evidenceTableExists = (): boolean => {
      const db = new Database(dbFile, { readonly: true });
      try {
        return db.query("select 1 from sqlite_master where type = 'table' and name = 'event_prune'").get() !== null;
      } finally {
        db.close();
      }
    };
    try {
      const db = new Database(dbFile);
      try {
        db.exec("create table event_prune (aggregate_id text not null, seq integer not null, type text not null, origin text not null)");
        db.exec("insert into event_prune values ('workflow:w1', 1, 'queue.state.changed', 'runtime')");
        // The release that wrote this table predates the settled row, so its
        // store has none and its first open runs every stored-fact pass.
        db.exec("delete from event where type = 'workspace.facts.settled'");
      } finally {
        db.close();
      }
      const joined = prepareWorkspaceState(directories());
      joined.generation.release();
      expect(evidenceTableExists()).toBe(true);
    } finally {
      await holder.stop();
    }

    const prepared = prepareWorkspaceState(directories());
    try {
      expect(evidenceTableExists()).toBe(false);
    } finally {
      prepared.generation.release();
    }
  }, 30_000);

  it("joins the current generation as a participant that owns nothing of its own", () => {
    const dbFile = unownedWorkspace();

    expect(openWorkspaceState(TMP)).toBe(resolveEventStoreDbFile(TMP));

    // The participant took no ownership, so the generation is still replaceable.
    stampEpoch(dbFile, OLD_EPOCH);
    const prepared = prepareWorkspaceState(directories());
    try {
      expect(readEpoch(prepared.dbFile)).toBe(WORKSPACE_STATE_EPOCH);
    } finally {
      prepared.generation.release();
    }
  });

  it("refuses to join a generation that is not the current epoch", () => {
    const dbFile = unownedWorkspace();
    stampEpoch(dbFile, OLD_EPOCH);

    expect(() => openWorkspaceState(TMP)).toThrow(`workspace state epoch ${OLD_EPOCH} is not the current epoch ${WORKSPACE_STATE_EPOCH}`);
    expect(readEpoch(dbFile)).toBe(OLD_EPOCH);
    expect(existsSync(join(flywheelDir(), "retiring"))).toBe(false);
  });

  it("retires an old generation exactly once when two starts race it", async () => {
    await unownedLegacyWorkspace();
    const script = writeWorker("starter.ts", STARTER);
    const barrier = join(TMP, "go");

    const children = [0, 1].map(() =>
      Bun.spawn(["bun", script, JSON.stringify(directories()), barrier], { cwd: REPO, stdout: "pipe", stderr: "pipe", windowsHide: true }));
    writeFileSync(barrier, "");
    const runs = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      out: (await new Response(child.stdout).text()).trim(),
      err: await new Response(child.stderr).text(),
    })));

    for (const run of runs) expect(run.code === 0 ? "" : run.err).toBe("");
    expect(runs.map((run) => run.out).toSorted()).toEqual(["joined", "retired"]);
    expect(readEpoch(resolveEventStoreDbFile(TMP))).toBe(WORKSPACE_STATE_EPOCH);
    await requireRetiredWorkspace(TMP);
  }, 60_000);
});

/** Every member the fixture's generation holds, in the order the manifest names
 *  them. */
const MEMBERS = [
  ...WORKSPACE_DATABASE_MEMBERS,
  "sessions",
  "agent-outputs",
] as const;

/** Every durable point of the retirement sequence, in the order it writes them:
 *  before the first move, between every member move, at both ends of the
 *  replacement stamp and of its publication, and between every deletion of the
 *  staged tree. A start is killed at each one in turn, and the next start must
 *  finish the work rather than find the project in a state it cannot classify. */
const CHECKPOINTS: readonly RetirementCheckpoint[] = [
  "manifest-published",
  ...MEMBERS.map((name) => `member-staged:${name}` as const),
  "phase-recorded:staged",
  "phase-recorded:stamping",
  "phase-recorded:stamped",
  "phase-recorded:publishing",
  "phase-recorded:published",
  "phase-recorded:discarding",
  ...MEMBERS.map((name) => `member-discarded:${name}` as const),
  "phase-recorded:discarded",
];

describe("a start killed inside the retirement sequence", () => {
  for (const checkpoint of CHECKPOINTS) {
    it(`is finished by the next start after ${checkpoint}`, async () => {
      await unownedLegacyWorkspace();

      await interruptRetirementAt(directories(), checkpoint);
      const resumed = prepareWorkspaceState(directories());

      try {
        expect(readEpoch(resumed.dbFile)).toBe(WORKSPACE_STATE_EPOCH);
        await requireRetiredWorkspace(TMP);
      } finally {
        resumed.generation.release();
      }
    }, 30_000);
  }
});