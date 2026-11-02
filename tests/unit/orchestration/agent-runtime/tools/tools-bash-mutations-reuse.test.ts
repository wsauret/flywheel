/** Bash `mutates` commands of one session reusing its private copy through
 *  the shell runtime's pool: which landings give the copy back, and that a
 *  reused copy shows each command the project as it is now. */

import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import type { OwnedProcess } from "../../../../../src/infra/owned-subprocess.js";
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js";
import { asRecord } from "../../../../../src/infra/record.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js";
import { privateCopyRemovals } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { handoverAuthority } from "../_command-handover-fixtures.js";
import { makeMockOwnedProcess, type OwnedExit } from "./_bash-fixtures.js";
import { createRecordingFileMutationStore } from "./_fixtures.js";
import { bashMutationHarness, bashMutationSession, settled } from "./_bash-mutations-harness.js";

const createDirectory = temporaryDirectories();

beforeAll(async () => {
  await loadBashParser();
});

const TERMINATED: OwnedExit = { code: 143, signal: null, statusOf: "payload", ownership: "surrendered" };

describe("bash tool: a session's mutating commands reuse its private copy", () => {
  const { project, runMutation, runManagedMutation, runHandedOverMutation } = bashMutationHarness(createDirectory);
  const sessions: Array<ReturnType<typeof bashMutationSession>> = [];
  afterEach(async () => {
    for (const opened of sessions.splice(0)) await opened.runtime.close();
    await privateCopyRemovals();
  });

  function session() {
    const created = bashMutationSession();
    sessions.push(created);
    return created;
  }

  const mutations = (root: string) => path.join(root, ".flywheel", "sessions", "session-1", "scratch", "mutations");
  async function remainingCopies(root: string): Promise<string[]> {
    await privateCopyRemovals();
    return fs.readdirSync(mutations(root));
  }
  /** The home of the copy a command ran in: its working directory is the copy root, `<home>/tree/<name>`. */
  const homeOf = (launches: ReadonlyArray<{ readonly cwd: string | undefined }>) => path.dirname(path.dirname(launches.find(launch => launch.cwd !== undefined)!.cwd!));

  /** Runs `body` and answers the payloads of the `agent.bash.mutation.applied` records it wrote. */
  async function appliedRecords(body: () => Promise<void>) {
    const record = spyOn(DebugLog, "record");
    try {
      await body();
      return record.mock.calls.map(([event]) => event).filter(event => event.type === "agent.bash.mutation.applied").map(event => asRecord(event.payload) ?? {});
    } finally {
      record.mockRestore();
    }
  }

  function heldUntilTerminated(): () => OwnedProcess {
    return () => {
      const exit = Promise.withResolvers<OwnedExit>();
      return makeMockOwnedProcess({ exited: exit.promise, terminate: async () => { exit.resolve(TERMINATED); return TERMINATED; } });
    };
  }

  it("runs the next command in the same home, lands its change, records the copy pooled, and leaves no copy once the session closes", async () => {
    const root = project([["a.txt", "a\n"]]);
    const s = session();
    let first!: Awaited<ReturnType<typeof runMutation>>;
    let second!: Awaited<ReturnType<typeof runMutation>>;
    let seen = "";
    const records = await appliedRecords(async () => {
      first = await runMutation(root, cwd => fs.writeFileSync(path.join(cwd, "a.txt"), "one\n"), {}, s.context);
      second = await runMutation(root, cwd => {
        seen = fs.readFileSync(path.join(cwd, "a.txt"), "utf8");
        fs.writeFileSync(path.join(cwd, "b.txt"), "two\n");
      }, {}, { ...s.context, toolUseId: "bash-2" });
    });

    expect(homeOf(second.launches)).toBe(homeOf(first.launches));
    expect(seen).toBe("one\n");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("two\n");
    expect(second.result.content).toContain("Applied to the project:\nCreated b.txt");
    expect(records).toEqual([
      expect.objectContaining({ toolUseId: "bash-1", status: "completed", copy: "taken", fate: "pooled" }),
      expect.objectContaining({ toolUseId: "bash-2", status: "completed", copy: "refreshed", recloned: expect.any(Number), removed: expect.any(Number), refreshMs: expect.any(Number), fate: "pooled" }),
    ]);
    expect(records.some(payload => "retire" in payload)).toBe(false);
    await s.runtime.close();
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("shows the next command a same-size real write whose modification time was restored, and lands its edit without a conflict", async () => {
    const root = project([["a.txt", "aaaa\n"]]);
    const s = session();
    const first = await runMutation(root, cwd => fs.writeFileSync(path.join(cwd, "other.txt"), "x\n"), {}, s.context);
    const { atime, mtime } = fs.statSync(path.join(root, "a.txt"));
    fs.writeFileSync(path.join(root, "a.txt"), "bbbb\n");
    fs.utimesSync(path.join(root, "a.txt"), atime, mtime);
    let seen = "";
    const second = await runMutation(root, cwd => {
      seen = fs.readFileSync(path.join(cwd, "a.txt"), "utf8");
      fs.writeFileSync(path.join(cwd, "a.txt"), `${seen}mine\n`);
    }, {}, { ...s.context, toolUseId: "bash-2" });

    expect(homeOf(second.launches)).toBe(homeOf(first.launches));
    expect(seen).toBe("bbbb\n");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("bbbb\nmine\n");
    expect(asRecord(second.result.details)?.mutationEvidence).toMatchObject({ applied: 1, conflictMarkers: 0, notApplied: 0 });
  });

  it.skipIf(process.platform === "win32")("hides a file whose landing was refused from the next command, which lands nothing for it", async () => {
    const root = project([[path.join("sub", "x.txt"), "x\n"]]);
    const s = session();
    const first = await runMutation(root, cwd => {
      fs.writeFileSync(path.join(cwd, "sub", "left.txt"), "left\n");
      fs.rmSync(path.join(root, "sub"), { recursive: true });
      fs.writeFileSync(path.join(root, "sub"), "now a file\n");
    }, {}, s.context);
    expect(asRecord(first.result.details)?.mutationEvidence).toMatchObject({ applied: 0, notApplied: 1 });
    fs.rmSync(path.join(root, "sub"));
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "x.txt"), "x\n");
    let leftover = true;
    const second = await runMutation(root, cwd => { leftover = fs.existsSync(path.join(cwd, "sub", "left.txt")); }, {}, { ...s.context, toolUseId: "bash-2" });

    expect(homeOf(second.launches)).toBe(homeOf(first.launches));
    expect(leftover).toBe(false);
    expect(second.result.content).toContain("No project files changed.");
    expect(fs.existsSync(path.join(root, "sub", "left.txt"))).toBe(false);
  });

  it("discards a copy whose evidence staging failed after its change was published, so the next command takes a new home", async () => {
    const root = project([["a.txt", "a\n"]]);
    const s = session();
    const store = createRecordingFileMutationStore();
    // Staging answers while the change publishes, and refuses the landing's evidence once it is published.
    const failing: typeof store.writer = { ...store.writer, stageSessionContentNodes: async nodes => {
      if (store.facts.some(fact => fact.type === "file.changed")) throw new Error("staging refused");
      await store.writer.stageSessionContentNodes(nodes);
    } };
    let firstHome = "";
    const records = await appliedRecords(async () => {
      await runMutation(root, cwd => {
        firstHome = path.dirname(path.dirname(cwd));
        fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
      }, {}, { ...s.context, sessionEventWriter: failing }).catch(() => undefined);
    });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(records).toEqual([expect.objectContaining({ status: "completed", fate: "discarded" })]);
    const second = await runMutation(root, () => {}, {}, { ...s.context, toolUseId: "bash-2" });

    expect(homeOf(second.launches)).not.toBe(firstHome);
    expect(await remainingCopies(root)).toEqual([path.basename(homeOf(second.launches))]);
  });

  it.skipIf(process.platform === "win32").each(["base", "session-before"])("retires a copy whose %s directory the command replaced with a link, and never writes through the link", async (name) => {
    const root = project([["a.txt", "a\n"], [path.join(".flywheel", "sessions", "session-1", "scratch", "note.md"), "note\n"]]);
    const outside = fs.realpathSync(createDirectory("agent-bash-mutations-outside-"));
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep\n");
    const before = fs.readdirSync(outside, { recursive: true }).map(entry => [entry, fs.readFileSync(path.join(outside, String(entry)), "utf8")]);
    const s = session();
    let first!: Awaited<ReturnType<typeof runMutation>>;
    const records = await appliedRecords(async () => {
      first = await runMutation(root, cwd => {
        const entry = path.join(cwd, "..", "..", name);
        fs.rmSync(entry, { recursive: true });
        fs.symlinkSync(outside, entry);
      }, {}, s.context);
    });
    expect(records).toEqual([expect.objectContaining({ fate: "pooled" })]);
    const second = await runMutation(root, () => {}, {}, { ...s.context, toolUseId: "bash-2" });

    expect(homeOf(second.launches)).not.toBe(homeOf(first.launches));
    expect(fs.readdirSync(outside, { recursive: true }).map(entry => [entry, fs.readFileSync(path.join(outside, String(entry)), "utf8")])).toEqual(before);
    expect(await remainingCopies(root)).toEqual([path.basename(homeOf(second.launches))]);
  });

  it("discards a copy when a process its command started may still run, and records why", async () => {
    const root = project([["a.txt", "a\n"]]);
    const s = session();
    let first!: Awaited<ReturnType<typeof runMutation>>;
    const records = await appliedRecords(async () => {
      first = await runMutation(root, cwd => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
        s.processes.set(999, { start: "200", ppid: 1 });
      }, {}, s.context);
    });
    expect(records).toEqual([expect.objectContaining({ status: "completed", copy: "taken", fate: "discarded", retire: "survivor" })]);
    const second = await runMutation(root, () => {}, {}, { ...s.context, toolUseId: "bash-2" });

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(homeOf(second.launches)).not.toBe(homeOf(first.launches));
  });

  it("keeps a copy whose landing was rejected as unverified with its record, and runs the next command in a new home", async () => {
    const root = project([["a.txt", "a\n"]]);
    const s = session();
    let first!: Awaited<ReturnType<typeof runMutation>>;
    const records = await appliedRecords(async () => {
      first = await runMutation(root, cwd => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
        fs.renameSync(cwd, `${cwd}.saved`);
        fs.writeFileSync(cwd, "not a directory");
      }, {}, s.context);
    });
    expect(records).toEqual([expect.objectContaining({ status: "repository_unverified", fate: "retained" })]);
    const second = await runMutation(root, () => {}, {}, { ...s.context, toolUseId: "bash-2" });

    expect(homeOf(second.launches)).not.toBe(homeOf(first.launches));
    expect(fs.existsSync(path.join(homeOf(first.launches), "copy.json"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  it("discards the copy of an interrupted command and records it discarded, so the next command takes a new home", async () => {
    const root = project([["a.txt", "a\n"]]);
    const s = session();
    const interrupt = new AbortController();
    let first!: Awaited<ReturnType<typeof runMutation>>;
    const records = await appliedRecords(async () => {
      first = await runMutation(root, cwd => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n");
        queueMicrotask(() => interrupt.abort());
      }, {}, { ...s.context, signal: interrupt.signal }, { make: heldUntilTerminated() });
    });
    expect(first.result.outcome).toBe("interrupted");
    expect(records).toEqual([expect.objectContaining({ status: "interrupted", copy: "taken", fate: "discarded" })]);
    expect(records.some(payload => "retire" in payload)).toBe(false);
    const second = await runMutation(root, () => {}, {}, { ...s.context, toolUseId: "bash-2" });

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(homeOf(second.launches)).not.toBe(homeOf(first.launches));
    expect(await remainingCopies(root)).toEqual([path.basename(homeOf(second.launches))]);
  });

  it("runs two concurrent background commands in separate homes, keeps exactly one once both land, and reuses it next", async () => {
    const root = project([["a.txt", "a\n"], ["b.txt", "b\n"]]);
    const s = session();
    const exits = [Promise.withResolvers<OwnedExit>(), Promise.withResolvers<OwnedExit>()];
    const homes: string[] = [];
    const background = { ...s.context, backgroundTasks: s.registry };
    await runManagedMutation(root, cwd => { homes.push(path.dirname(path.dirname(cwd))); fs.writeFileSync(path.join(cwd, "a.txt"), "mine a\n"); }, { background: true }, exits[0]!.promise, background);
    await runManagedMutation(root, cwd => { homes.push(path.dirname(path.dirname(cwd))); fs.writeFileSync(path.join(cwd, "b.txt"), "mine b\n"); }, { background: true }, exits[1]!.promise, { ...background, toolUseId: "bash-2" });
    expect(new Set(homes).size).toBe(2);
    for (const exit of exits) exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" });
    await settled(s.registry);

    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine a\n");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("mine b\n");
    const remaining = await remainingCopies(root);
    expect(remaining).toHaveLength(1);
    const third = await runMutation(root, () => {}, {}, { ...s.context, toolUseId: "bash-3" });
    expect(path.basename(homeOf(third.launches))).toBe(remaining[0]!);
  });

  it("never gives a handed-over command's copy back to the launching build's pool, and the adopting build removes it after landing", async () => {
    const root = project([["a.txt", "a\n"]]);
    const run = await runHandedOverMutation(root, cwd => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"));

    expect(run.beforeAdoption.copy).toBe(true);
    expect(run.launchingPool.checkout({ realRoot: root, treeName: path.basename(root), projectInTree: "", repository: false })).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
    expect(await remainingCopies(root)).toEqual([]);
  });

  it("discards the copy of a command that ended after its handover row named the copy, before its supervisor took it", async () => {
    const root = project([["a.txt", "a\n"]]);
    const s = session();
    const store = createSqliteEventStore(resolveEventStoreDbFile(createDirectory("agent-bash-mutations-store-")));
    const ended: OwnedExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" };
    // The supervisor answers the handover only after the command ended, so this build lands the copy.
    const container = (): OwnedProcess => {
      const exit = Promise.withResolvers<OwnedExit>();
      return makeMockOwnedProcess({ exited: exit.promise, handOver: async () => { exit.resolve(ended); return { kind: "exited", exit: ended }; } });
    };
    try {
      // The first command probes the host's mutation guard, which a held container would never answer, and leaves the copy the next one reuses.
      await runMutation(root, () => {}, {}, s.context);
      const records = await appliedRecords(async () => {
        await runManagedMutation(root, cwd => fs.writeFileSync(path.join(cwd, "a.txt"), "mine\n"), { background: true }, container, { ...s.context, backgroundTasks: s.registry, toolUseId: "bash-2" });
        await s.runtime.handOver({ authority: handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) }), sessionId: "session-1", conversationId: "conversation-1", holder: "conversation", deliver: async () => {} });
      });

      expect(records).toEqual([expect.objectContaining({ toolUseId: "bash-2", status: "completed", copy: "refreshed", fate: "discarded", retire: "handover" })]);
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("mine\n");
      expect(await remainingCopies(root)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("starts a new pool after an executor restart: the new runtime's command takes a new home and leaves the old one untouched", async () => {
    const root = project([["a.txt", "a\n"]]);
    const dropped = session();
    const first = await runMutation(root, () => {}, {}, dropped.context);
    const oldHome = homeOf(first.launches);
    const edited = path.join(oldHome, "tree", path.basename(root), "a.txt");
    fs.writeFileSync(edited, "edited in the old copy\n");
    const restarted = session();
    const second = await runMutation(root, cwd => fs.writeFileSync(path.join(cwd, "b.txt"), "b\n"), {}, { ...restarted.context, toolUseId: "bash-2" });

    expect(homeOf(second.launches)).not.toBe(oldHome);
    expect(fs.readFileSync(edited, "utf8")).toBe("edited in the old copy\n");
    expect(fs.existsSync(path.join(oldHome, "copy.json"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("b\n");
  });
});
