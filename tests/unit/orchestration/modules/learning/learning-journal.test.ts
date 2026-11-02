import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { POSIX_FILE_MODES } from "../../../../helpers/posix-modes.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

import { contentEvidence } from "../../../../../src/infra/content-evidence.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventReader, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js";
import {
  openPendingAudit,
  reconcilePendingAudits,
  type AuditFact,
  type PendingAudit,
} from "../../../../../src/orchestration/modules/learning/learning-journal.js";
import { createSessionFactWriter, type SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { memoryWrittenFact } from "../../../../../src/workflows/memory/memory-fact-writers.js";
import { skillWrittenFact } from "../../../../../src/workflows/skill-facts.js";
import { packageDigestAt } from "../../../../../src/orchestration/modules/learning/skill-package-planning.js";
import { publishSkillRevision, SKILL_FILE } from "../../../../../src/workflows/skill-schema.js";
import { planSkillMutation } from "../../../../../src/orchestration/modules/learning/skill-mutation-plan.js";
import { runOperation } from "../../../../../src/orchestration/modules/learning/global-skill-mutation-protocol.js";
import { operationIdentity, writeOperationManifest } from "../../../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import { canonicalMutationPath } from "../../../../../src/infra/file-mutation-queue.js";
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js";

const TMP = fileTemporaryDirectory("flywheel-learning-journal-test-");
const SESSION = "sess-audit";
const MEMORY_BODY = "- one durable fact\n";
const MEMORY_HASH = contentEvidence(MEMORY_BODY).sha256;

let store: LocalSqliteEventStore;
let writer: SessionFactWriter;
let storeDir: string;
let workspace: string;
let memoryPath: string;

function memoryFact(mutationId: string, contentHash = MEMORY_HASH): AuditFact {
  return memoryWrittenFact({
    target: "project",
    action: "add",
    origin: { kind: "agent", sessionId: SESSION },
    mutationId,
    contentHash,
  });
}

function skillFact(writeId: string, proposalId = "p".repeat(64)): AuditFact {
  return skillWrittenFact({
    name: "review-migrations",
    action: "created",
    reach: "project",
    origin: { kind: "agent", sessionId: SESSION },
    writeId,
    proposalId,
    contentHash: "hash-1",
    packageIdentity: { sha256: "hash-1", bytes: 12 },
    description: "How to review database migrations.",
  });
}

/** The published memory file this workspace's entries assert. */
function publishMemory(body = MEMORY_BODY): void {
  writeFileSync(memoryPath, body);
}

/** Journal one memory entry the way the tool does: against the content it
 *  publishes and the content it replaces. */
function openMemoryEntry(mutationId: string, options: { contentHash?: string; previous?: string | null } = {}): string {
  const contentHash = options.contentHash ?? MEMORY_HASH;
  return openPendingAudit({
    storeDir,
    workspace,
    fact: memoryFact(mutationId, contentHash),
    intended: { kind: "file", path: memoryPath, sha256: contentHash, previous: options.previous ?? null },
  }).path;
}

function reconcile(reader: EventReader = store): Promise<number> {
  return reconcilePendingAudits({ storeDir, workspace, writer, reader: asAsyncEventReadSurface(reader) });
}

function reconcileWithActive(active: PendingAudit): Promise<number> {
  return reconcilePendingAudits({ storeDir, workspace, writer, reader: asAsyncEventReadSurface(store), active });
}

function journalNames(): readonly string[] {
  const dir = join(storeDir, ".operations", "audit");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function recordedMutationIds(type: AuditFact["type"]): readonly string[] {
  return store.read({ types: [type], afterPosition: 0 }).map((event) => {
    if (!("identity" in event.payload)) return "missing-identity";
    const identity = event.payload.identity;
    if (typeof identity !== "object" || identity === null || !("mutationId" in identity)) return "missing-identity";
    return String(identity.mutationId);
  });
}

function recordedCount(type: AuditFact["type"]): number {
  return store.read({ types: [type], afterPosition: 0 }).length;
}

/** A real package on disk, so a package entry is settled by a digest the store
 *  actually holds. */
function installPackage(name: string): string {
  const dir = join(storeDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_FILE), "---\ndescription: Use for migration reviews.\n---\nBody.\n");
  return dir;
}

beforeEach(() => {
  storeDir = join(TMP, randomUUID());
  workspace = join(storeDir, "workspace-store");
  mkdirSync(workspace, { recursive: true });
  memoryPath = join(storeDir, "project.md");
  store = createSqliteEventStore(join(storeDir, "events.sqlite"));
  writer = createSessionFactWriter({ sessionId: SESSION, writer: asAsyncEventWriter(store) });
});

afterEach(() => {
  writer.dispose();
  store.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("audit outbox permissions", () => {
  it("tightens an existing audit directory and creates a private journal entry", () => {
    const auditDir = join(storeDir, ".operations", "audit");
    mkdirSync(auditDir, { recursive: true, mode: 0o755 });

    const entry = openMemoryEntry("private-audit");

    if (POSIX_FILE_MODES) expect(statSync(auditDir).mode & 0o777).toBe(0o700);
    if (POSIX_FILE_MODES) expect(statSync(entry).mode & 0o777).toBe(0o600);
  });
});

describe("audit outbox reconciliation", () => {
  it.each([3, 60])("advances the audit identity index after %i retained mutations", async (history) => {
    for (let i = 0; i < history; i++) await writer.record(memoryFact(`retained-${i}`));
    publishMemory();
    const counter = countStateRequests(asAsyncEventReadSurface(store));
    const input = { storeDir, workspace, writer, reader: counter.reader };
    openMemoryEntry("retained-0");
    expect(await reconcilePendingAudits(input)).toBe(0);
    counter.take();

    await writer.record(memoryFact("new-mutation"));
    openMemoryEntry("new-mutation");
    expect(await reconcilePendingAudits(input)).toBe(0);
    const requests = counter.take();
    expect(factsRead(requests)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(recordedCount("memory.written")).toBe(history + 1);
    expect(journalNames()).toEqual([]);
  });

  it.each([1, 2] as const)("recovers actual protocol journals for manifest v%s, including the old workspace key", async (version) => {
    const config = { projectRoot: workspace, userDataRoot: join(storeDir, "account"), registry: () => publishSkillRevision(1, new Map()) };
    const globalRoot = join(config.userDataRoot, "skills");
    const projectStoreDir = join(workspace, ".flywheel", "skills");
    const planned = planSkillMutation(config, { kind: "agent", sessionId: SESSION }, { kind: "save", name: "journal-test", description: "Use for journal tests.", body: "Body.", reach: "global" });
    if (planned.kind !== "planned") throw new Error(planned.error);
    const origin = { sessionId: SESSION, interactionId: "journal-operation" };
    const manifest = { version, state: "claimed" as const, transition: 2, createdAt: Date.now(), updatedAt: Date.now(), globalStoreDir: globalRoot, projectStoreDir, origin, operationId: operationIdentity(origin, planned.plan.proposalId), plan: planned.plan };
    writeOperationManifest(globalRoot, manifest);
    const run = runOperation(globalRoot, manifest);
    expect(run.outcome.kind).toBe("published");
    expect(run.pending.length).toBeGreaterThan(0);
    for (const pending of run.pending) {
      const record = JSON.parse(readFileSync(pending.path, "utf8"));
      expect(record.workspace).toBe(canonicalMutationPath(workspace));
    }
    const last = run.pending.at(-1);
    if (!last) throw new Error("The protocol did not journal its publication");
    const record = JSON.parse(readFileSync(last.path, "utf8"));
    writeFileSync(last.path, JSON.stringify({ ...record, workspace: canonicalMutationPath(projectStoreDir) }));
    expect(await reconcilePendingAudits({ storeDir: globalRoot, workspace: join(workspace, "other"), writer, reader: asAsyncEventReadSurface(store) })).toBe(0);
    expect(await reconcilePendingAudits({ storeDir: globalRoot, workspace, writer, reader: asAsyncEventReadSurface(store) })).toBe(run.pending.length);
    expect(recordedCount("skill.operation.transitioned")).toBe(run.pending.length);
    expect(run.pending.every((pending) => !existsSync(pending.path))).toBe(true);
    expect(await reconcilePendingAudits({ storeDir: globalRoot, workspace, writer, reader: asAsyncEventReadSurface(store) })).toBe(0);
  });
  // The crash window: the append landed and the process died before the entry
  // was dropped. Replay must settle the entry, not record the write twice.
  it("settles a skill entry whose append the store already accepted without a second fact", async () => {
    const packageDir = installPackage("review-migrations");
    const sha256 = packageDigestAt(packageDir);
    if (!sha256) throw new Error("the installed package has no digest");
    const fact = skillFact("write-skill-1");
    openPendingAudit({ storeDir, workspace, fact, intended: { kind: "package", dir: packageDir, sha256, previous: null } });
    expect(await writer.record(fact)).not.toBeNull();
    expect(journalNames()).toHaveLength(1);

    expect(await reconcile()).toBe(0);

    expect(recordedCount("skill.written")).toBe(1);
    expect(journalNames()).toEqual([]);
  });

  // The proposal identity is content-bound, so a second write that produces the
  // same package bytes carries the same one. Only the write identity separates
  // this entry from evidence of that other write.
  it("records a second write of identical package content under its own write identity", async () => {
    const packageDir = installPackage("review-migrations");
    const sha256 = packageDigestAt(packageDir);
    if (!sha256) throw new Error("the installed package has no digest");
    expect(await writer.record(skillFact("write-skill-1"))).not.toBeNull();
    openPendingAudit({
      storeDir,
      workspace,
      fact: skillFact("write-skill-2"),
      intended: { kind: "package", dir: packageDir, sha256, previous: null },
    });

    expect(await reconcile()).toBe(1);

    expect(recordedCount("skill.written")).toBe(2);
  });

  // The package rule is the file rule: only the pre-state disproves an entry, so
  // a later write of the same package cannot erase the evidence of this one.
  it("drops a package entry whose package still holds the content it was measured against", async () => {
    const packageDir = installPackage("review-migrations");
    const previous = packageDigestAt(packageDir);
    if (!previous) throw new Error("the installed package has no digest");
    openPendingAudit({
      storeDir,
      workspace,
      fact: skillFact("write-skill-1"),
      intended: { kind: "package", dir: packageDir, sha256: "0".repeat(64), previous },
    });

    expect(await reconcile()).toBe(0);

    expect(recordedCount("skill.written")).toBe(0);
    expect(journalNames()).toEqual([]);
  });

  // Identity keys the probe, not content: a later write that leaves the store
  // in the same state is a different mutation and owes its own fact.
  it("moves aside an entry with no mutation identity instead of risking a duplicate", async () => {
    const auditDir = join(storeDir, ".operations", "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "1-no-identity.json"), JSON.stringify({
      version: 1,
      workspace,
      intended: { kind: "file", path: memoryPath, sha256: MEMORY_HASH, previous: null },
      fact: {
        type: "memory.written",
        version: 3,
        actor: "agent",
        payload: {
          target: "project",
          action: "add",
          origin: { kind: "agent", sessionId: SESSION },
          identity: { kind: "adopted_v1" },
          contentHash: MEMORY_HASH,
        },
      },
    }));

    expect(await reconcile()).toBe(0);

    expect(recordedCount("memory.written")).toBe(0);
    expect(journalNames()).toEqual(["1-no-identity.json.unusable"]);
  });

  it("moves aside a linked journal entry without consuming its target", async () => {
    const auditDir = join(storeDir, ".operations", "audit");
    mkdirSync(auditDir, { recursive: true });
    const outside = join(TMP, "outside-journal.json");
    const outsideRecord = JSON.stringify({
      version: 1,
      workspace,
      intended: { kind: "file", path: memoryPath, sha256: MEMORY_HASH, previous: null },
      fact: memoryFact("linked-journal-write"),
    });
    writeFileSync(outside, outsideRecord);
    symlinkSync(outside, join(auditDir, "1-linked.json"));

    expect(await reconcile()).toBe(0);
    expect(recordedCount("memory.written")).toBe(0);
    expect(journalNames()).toEqual(["1-linked.json.unusable"]);
    await expect(Bun.file(outside).text()).resolves.toBe(outsideRecord);
  });

  it("does not read a package through a link outside its store", async () => {
    const outside = join(TMP, "outside-package");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, SKILL_FILE), "---\ndescription: Use for outside work.\n---\nOutside.\n");
    const sha256 = packageDigestAt(outside);
    if (!sha256) throw new Error("the outside package has no digest");
    const linked = join(storeDir, "linked-package");
    symlinkSync(outside, linked);
    openPendingAudit({
      storeDir,
      workspace,
      fact: skillFact("linked-package-write"),
      intended: { kind: "package", dir: linked, sha256, previous: null },
    });

    expect(await reconcile()).toBe(0);
    expect(recordedCount("skill.written")).toBe(0);
    expect(journalNames()).toEqual([]);
  });

  // An entry is opened before the artifact changes, so a refused or conflicting
  // mutation leaves one behind for a change that never happened. The pre-state
  // it was measured against is the proof: the store still holds it.
  it("drops an entry whose intended artifact state was never published", async () => {
    openMemoryEntry("mutation-memory-5");

    expect(await reconcile()).toBe(0);

    expect(recordedCount("memory.written")).toBe(0);
    expect(journalNames()).toEqual([]);
  });

  // A later write of the same store is not proof against an earlier one: the
  // store holds neither the content this entry published nor the content it
  // replaced, so this entry is the only record of a change that did happen.
  it("records an entry a later write of the same store moved past", async () => {
    openMemoryEntry("mutation-memory-11");
    publishMemory("- a later write entirely\n");

    expect(await reconcile()).toBe(1);

    expect(recordedMutationIds("memory.written")).toEqual(["mutation-memory-11"]);
    expect(journalNames()).toEqual([]);
  });

  // Transitions of one operation are journalled in order and must be recorded in
  // that order, so the ordering key cannot be the wall clock alone: entries
  // opened inside one millisecond would then replay in an arbitrary order.
  it("replays entries in the order they were journalled", async () => {
    publishMemory();
    const opened = [
      openMemoryEntry("mutation-memory-12"),
      openMemoryEntry("mutation-memory-13"),
      openMemoryEntry("mutation-memory-14"),
    ].map((path) => path.slice(path.lastIndexOf("/") + 1));

    expect([...opened].sort()).toEqual(opened);
    expect(await reconcile()).toBe(3);
    expect(recordedMutationIds("memory.written")).toEqual(["mutation-memory-12", "mutation-memory-13", "mutation-memory-14"]);
  });

  // The outbox is shared by every project that reads one store, and the fact
  // belongs to the session aggregate of the workspace that opened the entry.
  it("leaves an entry another workspace opened for that workspace", async () => {
    publishMemory();
    openPendingAudit({
      storeDir,
      workspace: join(storeDir, "other-workspace-store"),
      fact: memoryFact("mutation-memory-7"),
      intended: { kind: "file", path: memoryPath, sha256: MEMORY_HASH, previous: null },
    });

    expect(await reconcile()).toBe(0);

    expect(recordedCount("memory.written")).toBe(0);
    expect(journalNames()).toHaveLength(1);
  });

  // One indexed read answers the whole pass; a read per entry would grow with
  // the outbox.
  it("reads the recorded identities once for the whole pass", async () => {
    publishMemory();
    // A recorded fact gives the store a position, so the pass must read it.
    expect(await writer.record(memoryFact("mutation-memory-7"))).not.toBeNull();
    openMemoryEntry("mutation-memory-8");
    openMemoryEntry("mutation-memory-9");
    openMemoryEntry("mutation-memory-10");
    let reads = 0;
    const counting: EventReader = {
      ...store,
      read: (query) => {
        reads += 1;
        return store.read(query);
      },
    };

    expect(await reconcile(counting)).toBe(3);

    expect(reads).toBe(1);
  });

  // A writer journals its entry before the change it describes, so a pass that
  // ran inside that window would read the untouched artifact as proof the change
  // never landed and erase the evidence of a change about to happen.
  it("leaves the caller's own entry alone while its change is still unpublished", async () => {
    publishMemory();
    const active = openPendingAudit({
      storeDir,
      workspace,
      fact: memoryFact("mutation-memory-15"),
      intended: { kind: "file", path: memoryPath, sha256: "0".repeat(64), previous: MEMORY_HASH },
    });

    expect(await reconcileWithActive(active)).toBe(0);

    expect(recordedCount("memory.written")).toBe(0);
    expect(journalNames()).toHaveLength(1);
    // Every other entry of the same workspace is still settled by that pass.
    openMemoryEntry("mutation-memory-16");
    expect(await reconcileWithActive(active)).toBe(1);
    expect(recordedMutationIds("memory.written")).toEqual(["mutation-memory-16"]);
    expect(journalNames()).toHaveLength(1);
  });
});
