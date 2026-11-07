import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inMemoryEventReader } from "../../../../../helpers/in-memory-event-reader.js";
import { asAsyncEventReadSurface, type StoredFact } from "../../../../../../src/infra/event-store-types.js";
import type { SessionNoticeOperation } from "../../../../../../src/infra/session-notice.js";
import { readMutationEvidenceFiles } from "../../../../../../src/infra/mutation-evidence.js";
import { MutationEvidenceSchema } from "../../../../../../src/infra/mutation-evidence-schema.js";
import { readSessionContentRange, type SessionContentNode } from "../../../../../../src/infra/session-content.js";
import type { CapabilityCheck } from "../../../../../../src/infra/capability-text.js";
import { createMemoryTool } from "../../../../../../src/orchestration/modules/learning/tools/memory.js";
import { capabilityAccessFor, type CapabilityAccess, type RuntimeTool, type ToolContext } from "../../../../../../src/orchestration/agent-runtime/tools/types.js";
import { executePreparedTool, prepareToolCall } from "../../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { CapabilityGrant } from "../../../../../../src/orchestration/config/module-policy.js";
import { composeFirstPartyModules, type ModuleId } from "../../../../../../src/orchestration/modules.js";
import { testKernelToolDeps } from "../../../../../helpers/request-tool-surface.js";
import { fileTemporaryDirectory } from "../../../../../helpers/directories.js";
import { moduleDisabledReason } from "../../../../../../src/protocol/module-ids"

type SessionFact = Parameters<NonNullable<ToolContext["sessionEventWriter"]>["record"]>[0];
interface UnknownRecord { [key: string]: unknown }

function asRecord(value: ReturnType<typeof JSON.parse>): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value;
}

function parseRecord(json: string): UnknownRecord {
  return asRecord(JSON.parse(json));
}

function stringArrayField(record: UnknownRecord, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`expected ${key} to contain strings`);
    strings.push(item);
  }
  return strings;
}

function resultContent(result: { content: string | object }): string {
  if (typeof result.content !== "string") throw new Error("expected string tool content");
  return result.content;
}

function mutationDetails(value: ReturnType<typeof JSON.parse>) {
  const details = asRecord(value);
  if (!("mutationEvidence" in details)) throw new Error("expected mutation evidence details");
  return { mutationEvidence: details.mutationEvidence };
}

const TMP = fileTemporaryDirectory("flywheel-memory-tool-test-");

let recorded: SessionFact[] = [];
let notices: SessionNoticeOperation[] = [];
const contentNodes = new Map<string, SessionContentNode>();

// A writer that resolves null wrote nothing, which the tool treats as a failed
// audit record, so the accepting fake resolves a stored-event stand-in.
function storedStub(): StoredFact {
  return { id: `evt-${recorded.length}`, position: recorded.length, seq: recorded.length, aggregateId: "session:sess-test", sessionId: "sess-test", type: "memory.written", version: 3, timestamp: 0, actor: "flywheel", payload: {} };
}

function makeContext(record?: (fact: SessionFact) => Promise<StoredFact | null>): ToolContext {
  return {
    executionCwd: join(TMP, "project"),
    userDataRoot: join(TMP, "account"), projectRoot: join(TMP, "project"),
    // The tool context's sessionId is the conversation id, never the session.
    sessionId: "conv-test",
    toolUseId: "memory-call",
    artifactScopeId: "sess-test",
    retrievalSessionId: "sess-test",
    sessionEventWriter: {
      stageSessionContentNodes: async (nodes) => { for (const row of nodes) contentNodes.set(row.sha256, row.node); },
      record: (fact: SessionFact) => {
        recorded.push(fact);
        return record ? record(fact) : Promise.resolve(storedStub());
      },
      recordBatch: async () => { throw new Error("unexpected batch write"); },
      recordGuarded: async () => { throw new Error("unexpected guarded write"); },
      transaction: async (run) => { run(); },
      dispose: () => {},
    },
  };
}

/** A context of a runtime that records nothing: no session event writer at all. */
function makeWriterlessContext(): ToolContext {
  return { executionCwd: join(TMP, "project"), userDataRoot: join(TMP, "account"), projectRoot: join(TMP, "project"), sessionId: "conv-test", artifactScopeId: "sess-test", retrievalSessionId: "sess-test" };
}

function auditJournalEntries(): readonly string[] {
  const dir = join(TMP, "project", ".flywheel", "memory", ".operations", "audit");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function memoryFile(): string {
  return join(TMP, "project", ".flywheel", "memory", "MEMORY.json");
}

/** Every capability holds for the tree unless a test passes its own check. */
const ALL_CAPABILITIES: CapabilityCheck = () => true;

function makeTool(overrides: { sessionId?: string } = {}, has: CapabilityCheck = ALL_CAPABILITIES): ReturnType<typeof createMemoryTool> {
  const deps = {
    accountHome: join(TMP, "home"),
    sessionId: "sess-test",
    onNotice: (operation: SessionNoticeOperation) => notices.push(operation),
    ...overrides,
  };
  return createMemoryTool(deps, has);
}

/** The tool of a runtime that can also replay the outbox: it holds a reader of
 *  the workspace event store, which holds no audit facts here. */
function replayingTool(): ReturnType<typeof createMemoryTool> {
  const deps = {
    accountHome: join(TMP, "home"),
    sessionId: "sess-test",
    onNotice: (operation: SessionNoticeOperation) => notices.push(operation),
    store: asAsyncEventReadSurface(inMemoryEventReader([])),
  };
  return createMemoryTool(deps, ALL_CAPABILITIES);
}

async function call(tool: ReturnType<typeof createMemoryTool>, input: UnknownRecord) {
  const result = await tool.execute({ title: "Test memory update", ...input }, makeContext());
  const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  return { outcome: result.outcome, body: parseRecord(content) };
}

function access(selected: readonly ModuleId[], grant?: CapabilityGrant): CapabilityAccess {
  return capabilityAccessFor({
    state: () => ({ moduleIds: selected, capabilities: selected, requireWorkflowConfirmation: true, workflowsMode: "off", identity: selected.join("+") }),
    admit: async (request) => {
      const missing = request.required.filter((capability) => !selected.includes(capability));
      return missing.length === 0
        ? { ok: true, grant: { operation: request.operation, required: request.required, moduleIds: selected, capabilities: selected, requireWorkflowConfirmation: true, workflowsMode: "off", identity: selected.join("+") } }
        : { ok: false, missing, reason: `${request.operation} is unavailable: ${moduleDisabledReason(missing)}` };
    },
  }, grant);
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "project"), { recursive: true });
  mkdirSync(join(TMP, "home"), { recursive: true });
  recorded = [];
  notices = [];
  contentNodes.clear();
});

describe("memory tool", () => {
  it("reserves scarce memory for selective cross-session context", () => {
    const description = makeTool().description;
    expect(description).toContain("selective profile");
    expect(description).toContain("many future sessions");
    expect(description).toContain("AGENTS.md");
    expect(description).toContain("Session notes");
    expect(description).toContain("Saving nothing is often correct");
    expect(description).not.toContain("environment facts > procedures");
  });

  it("requires sizing the final memory update before submission", () => {
    const description = makeTool().description;
    expect(description).toContain("BEFORE CALLING");
    expect(description).toContain("current usage - removed/replaced entry lengths + replacement/new entry lengths");
    expect(description).toContain("UTF-16");
    expect(description).toContain("trim in this same batch before submitting");
    expect(description).not.toContain("IF FULL:");
  });

  it("requires a generated transcript title", () => {
    const tool = makeTool();
    const schema = asRecord(tool.inputSchema);
    const properties = asRecord(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    expect(properties.title).toBeDefined();
    expect(required).toContain("title");
    expect(tool.description).toContain("entries labeled [protected] are user-owned");
    expect(tool.description).toContain("never use any other tool to alter their content");
    expect(tool.description).not.toContain("shell");
  });

  it("sends a repeatable procedure to a skill only while the tree can write one", () => {
    const treeCheck = (disabled: readonly ModuleId[]) => testKernelToolDeps({ moduleSnapshot: composeFirstPartyModules(undefined, disabled) }).treeCapabilities;
    const withSkills = makeTool({}, treeCheck([])).description;
    expect(withSkills).toContain("Repeatable procedures belong in skills.");
    expect(withSkills).toContain("A repeatable procedure belongs in a skill, not memory.");
    const withoutSkills = makeTool({}, treeCheck(["skills"])).description;
    expect(withoutSkills).not.toContain("skill");
    expect(withoutSkills).toContain("Maintain that authority rather than duplicating it in memory.\n\nMAKING ROOM");
  });

  it("offers the project and global reach vocabulary as an optional target", () => {
    const schema = asRecord(makeTool().inputSchema);
    const properties = asRecord(schema.properties);
    const target = asRecord(properties.target);
    const values = Array.isArray(target.enum) ? target.enum : [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    expect(values).toEqual(["project", "global"]);
    // The tool defaults an omitted target to project reach, so a schema that
    // demands it would force the model to state a reach it has no opinion on.
    expect(required).not.toContain("target");
  });

  it("advertises and enforces the memory batch operation limit", async () => {
    const tool = makeTool();
    const schema = asRecord(tool.inputSchema);
    const operations = asRecord(asRecord(schema.properties).operations);

    expect(operations.maxItems).toBe(64);

    const dispatch = (count: number) => {
      const tools = new Map<string, RuntimeTool>([["memory", tool]]);
      const prepared = prepareToolCall({
        id: "memory-call",
        name: "memory",
        input: {
          title: "Test memory update",
          operations: Array.from({ length: count }, () => ({ action: "add", content: "Duplicate." })),
        },
      }, tools);
      return executePreparedTool(prepared, { ...makeContext(), capabilityAccess: access(["learning"]) });
    };
    const result = await dispatch(65);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("`operations`");
    expect(result.content).toContain("65");
    expect(result.content).toContain("64");
    expect(existsSync(memoryFile())).toBe(false);
    expect(recorded).toHaveLength(0);

    const accepted = await dispatch(64);
    expect(accepted.outcome).toBe("ok");
    expect(recorded).toHaveLength(1);
  });

  it("refuses a title without visible text", async () => {
    const result = await call(makeTool(), {
      action: "add",
      target: "project",
      title: "\u0085\u200B",
      content: "Must not be written.",
    });
    expect(result.outcome).toBe("error");
    expect(result.body.error).toContain("title");
    expect(recorded).toHaveLength(0);
  });

  it("routes each reach to its store file and emits facts without status notices", async () => {
    const tool = makeTool();
    const global = await call(tool, { action: "add", target: "global", content: "Prefers concise replies." });
    const project = await call(tool, { action: "add", target: "project", content: "Repo uses bun." });

    expect(global.outcome).toBe("ok");
    expect(project.outcome).toBe("ok");
    expect(readFileSync(join(TMP, "home", ".flywheel", "memory", "USER.json"), "utf8")).toContain("concise");
    expect(readFileSync(join(TMP, "project", ".flywheel", "memory", "MEMORY.json"), "utf8")).toContain("bun");

    expect(recorded).toHaveLength(2);
    const fact = asRecord(recorded[0]);
    expect(fact.type).toBe("memory.written");
    expect(fact.version).toBe(3);
    expect(asRecord(fact.payload).target).toBe("global");
    // Session causality: the fact names the session this runner serves, not
    // the conversation the tool call arrived on.
    expect(asRecord(fact.payload).origin).toEqual({ kind: "agent", sessionId: "sess-test" });
    expect(notices).toHaveLength(0);
  });

  it("treats an omitted or null target as project reach", async () => {
    expect((await call(makeTool(), { action: "add", target: null, content: "Defaulted." })).outcome).toBe("ok");
    expect((await call(makeTool(), { action: "add", content: "Also defaulted." })).outcome).toBe("ok");
    expect(readFileSync(join(TMP, "project", ".flywheel", "memory", "MEMORY.json"), "utf8")).toContain("Also defaulted.");
    expect(existsSync(join(TMP, "home", ".flywheel", "memory", "USER.json"))).toBe(false);
  });

  it("refuses a target outside the reach vocabulary", async () => {
    const result = await call(makeTool(), { action: "add", target: "user", content: "Legacy vocabulary." });
    expect(result.outcome).toBe("error");
    expect(result.body.error).toContain("'project' or 'global'");
    expect(recorded).toHaveLength(0);
  });

  it("reports success only after the memory.written evidence settles", async () => {
    let releaseRecord: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseRecord = resolve; });
    const tool = makeTool();
    let settled = false;
    const pending = tool.execute(
      { title: "Gated write", action: "add", target: "project", content: "Gated entry." },
      makeContext(() => gate.then(() => storedStub())),
    ).then((result) => { settled = true; return result; });

    await new Promise((resolve) => setTimeout(resolve, 5));
    // The bytes are already on disk; the call has not reported success yet.
    expect(readFileSync(join(TMP, "project", ".flywheel", "memory", "MEMORY.json"), "utf8")).toContain("Gated entry.");
    expect(settled).toBe(false);

    releaseRecord();
    const result = await pending;
    expect(settled).toBe(true);
    expect(result.outcome).toBe("ok");
  });

  it("reports a terminal audit failure when the evidence cannot be recorded", async () => {
    const result = await makeTool().execute(
      { title: "Unrecordable write", action: "add", target: "project", content: "Unrecorded entry." },
      makeContext(() => Promise.reject(new Error("event store offline"))),
    );
    const body = parseRecord(resultContent(result));

    expect(result.outcome).toBe("error");
    expect(body.success).toBe(false);
    expect(body.done).toBe(true);
    expect(String(body.error)).toContain("audit");
    // The store file is the artifact: the bytes stay, the call does not claim success.
    expect(readFileSync(join(TMP, "project", ".flywheel", "memory", "MEMORY.json"), "utf8")).toContain("Unrecorded entry.");
    // Recoverable: the journalled fact waits for the next writer of this workspace.
    expect(auditJournalEntries()).toHaveLength(1);
  });

  it("journals the evidence and reports non-success when the runtime records no facts", async () => {
    const result = await makeTool().execute(
      { title: "Unattributable write", action: "add", target: "project", content: "Journalled entry." },
      makeWriterlessContext(),
    );
    const body = parseRecord(resultContent(result));

    expect(result.outcome).toBe("error");
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain("journalled");
    // The bytes are the artifact and the evidence is recoverable: the next
    // writer of this workspace replays the journalled fact.
    expect(readFileSync(join(TMP, "project", ".flywheel", "memory", "MEMORY.json"), "utf8")).toContain("Journalled entry.");
    expect(auditJournalEntries()).toHaveLength(1);
  });

  // The evidence of a stranded write is not erased by the write that follows it.
  // Only the pre-state it was measured against can prove it never landed, so a
  // store that holds neither state keeps the earlier evidence.
  it("records stranded evidence after a later write moved the store past it", async () => {
    await makeTool().execute(
      { title: "Stranded write", action: "add", target: "project", content: "Stranded entry." },
      makeWriterlessContext(),
    );
    expect(auditJournalEntries()).toHaveLength(1);
    writeFileSync(memoryFile(), JSON.stringify({ version: 1, entries: [{ content: "Something else entirely", protected: false }] }));

    const result = await call(replayingTool(), { action: "add", target: "project", content: "Later entry." });

    expect(result.outcome).toBe("ok");
    expect(auditJournalEntries()).toHaveLength(0);
    expect(recorded).toHaveLength(2);
  });

  it("refuses a write no session can be named for", async () => {
    const tool = createMemoryTool({ accountHome: join(TMP, "home") }, ALL_CAPABILITIES);

    const result = await tool.execute({ title: "No session", action: "add", target: "project", content: "x" }, makeContext());
    const body = parseRecord(resultContent(result));

    expect(result.outcome).toBe("error");
    expect(String(body.error)).toContain("session");
    expect(existsSync(join(TMP, "project", ".flywheel", "memory", "MEMORY.json"))).toBe(false);
    expect(recorded).toHaveLength(0);
    expect(auditJournalEntries()).toHaveLength(0);
  });

  it("returns the inventory and a retry instruction when replace arrives without old_text", async () => {
    const tool = makeTool();
    await call(tool, { action: "add", target: "project", content: "Existing entry." });

    const result = await call(tool, { action: "replace", target: "project", content: "New." });

    expect(result.outcome).toBe("error");
    expect(result.body.error).toContain("needs old_text");
    expect(result.body.current_entries).toEqual(["Existing entry."]);
    // A recovery is not a write: no fact, no notice beyond the add's.
    expect(recorded).toHaveLength(1);
  });

  it("applies a batch atomically and records one batch fact", async () => {
    const tool = makeTool();
    await call(tool, { action: "add", target: "project", content: "Old fact." });
    recorded = [];

    const result = await call(tool, {
      target: "project",
      operations: [
        { action: "remove", old_text: "Old fact" },
        { action: "add", content: "New fact." },
      ],
    });

    expect(result.outcome).toBe("ok");
    expect(result.body.note).toContain("do not repeat");
    expect(recorded).toHaveLength(1);
    expect(asRecord(recorded[0]).payload).toEqual(expect.objectContaining({ action: "batch" }));
  });

  it("returns a terminal stop-retrying result after three consecutive consolidation failures", async () => {
    const tool = makeTool();
    // Zero-match replaces are consolidation failures; the store is empty.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await call(tool, { action: "replace", target: "project", old_text: "absent", content: "x" });
      expect(result.body.done).toBeUndefined();
    }
    const fourth = await call(tool, { action: "replace", target: "project", old_text: "absent", content: "x" });

    expect(fourth.outcome).toBe("error");
    expect(fourth.body.done).toBe(true);
    expect(fourth.body.error).toContain("Stop retrying");

    // A success resets the cap: the next failure is instructive again.
    await call(tool, { action: "add", target: "project", content: "Progress." });
    const afterReset = await call(tool, { action: "replace", target: "project", old_text: "absent", content: "x" });
    expect(afterReset.body.done).toBeUndefined();
  });

  it("returns success without a fact when the entry already exists", async () => {
    const tool = makeTool();
    await call(tool, { action: "add", target: "project", content: "Same." });
    recorded = [];
    notices = [];

    const result = await call(tool, { action: "add", target: "project", content: "Same." });

    expect(result.outcome).toBe("ok");
    expect(result.body.message).toContain("already exists");
    expect(recorded).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });


  it("never echoes the entry list on success", async () => {
    const result = await call(makeTool(), { action: "add", target: "project", content: "Secret-adjacent detail." });
    expect(JSON.stringify(result.body)).not.toContain("Secret-adjacent detail.");
  });

  it("labels protected inventory and refuses replace or remove without audit evidence", async () => {
    mkdirSync(join(TMP, "project", ".flywheel", "memory"), { recursive: true });
    writeFileSync(memoryFile(), JSON.stringify({ version: 1, entries: [{ content: "User-owned entry.", protected: true }] }));
    const before = readFileSync(memoryFile(), "utf8");
    recorded = [];

    const inventory = await call(makeTool(), { action: "replace", target: "project", content: "Changed." });
    expect(stringArrayField(inventory.body, "current_entries")).toEqual(["[protected] User-owned entry."]);
    for (const action of ["replace", "remove"] as const) {
      const result = await call(makeTool(), {
        action,
        target: "project",
        old_text: "User-owned",
        ...(action === "replace" ? { content: "Changed." } : {}),
      });
      expect(result.outcome).toBe("error");
      expect(result.body.error).toContain("protected");
    }
    expect(readFileSync(memoryFile(), "utf8")).toBe(before);
    expect(recorded).toHaveLength(0);
    expect(auditJournalEntries()).toHaveLength(0);
  });
});


describe("memory tool mutation artifact", () => {
  it("persists the exact filtered global memory diff as the one tool-result artifact", async () => {
    const result = await makeTool().execute({
      title: "Save a personal fact",
      action: "add",
      target: "global",
      content: "Lives in Lisbon with two cats.",
    }, makeContext());

    expect(result.outcome).toBe("ok");
    const details = mutationDetails(result.details);
    const evidence = Schema.decodeUnknownSync(MutationEvidenceSchema)(details.mutationEvidence);
    const read = async (hash: string) => contentNodes.get(hash) ?? null;
    const page = await readMutationEvidenceFiles(evidence, 0, 10, read);
    if (page.kind !== "available") throw new Error("file evidence is unavailable");
    const entry = page.files[0];
    if (entry?.kind !== "display" || entry.file.patch.kind !== "retained") throw new Error("patch is unavailable");
    expect("before" in entry.file).toBe(false);
    expect("after" in entry.file).toBe(false);
    expect(evidence.omissions).toBe(0);
    expect(entry.file.path).toBe("USER.json");
    const range = await readSessionContentRange(entry.file.patch.reference, 0, 65536, read);
    if (range.kind !== "available") throw new Error("patch bytes are unavailable");
    expect(Buffer.from(range.base64, "base64").toString()).toContain("Lives in Lisbon with two cats.");
    expect(Object.keys(details)).toEqual(["mutationEvidence"]);
    expect(JSON.stringify(details)).not.toContain("Lives in Lisbon");
    expect(recorded.map(fact => fact.type)).toEqual(["memory.written"]);
  });

  it("carries no artifact when nothing changed on disk", async () => {
    const tool = makeTool();
    const input = { title: "Save a preference", action: "add", target: "project", content: "Same." };
    await tool.execute({ ...input }, makeContext());

    const again = await tool.execute({ ...input }, makeContext());

    expect(again.outcome).toBe("ok");
    expect(again.details).toBeUndefined();
  });

  it("reports unavailable display storage while preserving the memory write and audit", async () => {
    const context = makeContext();
    context.sessionEventWriter!.stageSessionContentNodes = async () => { throw new Error("disk unavailable"); };
    const result = await makeTool().execute({ title: "Save a preference", action: "add", target: "project", content: "Keep this saved fact." }, context);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Change evidence is unavailable");
    expect(result.content).toContain("do not repeat it");
    expect(readFileSync(memoryFile(), "utf8")).toContain("Keep this saved fact.");
    expect(recorded.map(fact => fact.type)).toEqual(["memory.written"]);
    expect(result.details).toBeUndefined();
  });

  it("retains a sensitive omission without inventing its change kind or endpoint identity", async () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-");
    mkdirSync(join(TMP, "project", ".flywheel", "memory"), { recursive: true });
    writeFileSync(memoryFile(), JSON.stringify({ version: 1, entries: [{ content: `Token: ${secret}`, protected: false }] }));
    const result = await makeTool().execute({ title: "Remove a stored credential", action: "replace", target: "project", old_text: "Token:", content: "Prefers local settings." }, makeContext());
    expect(result.outcome).toBe("ok");
    const evidence = Schema.decodeUnknownSync(MutationEvidenceSchema)(mutationDetails(result.details).mutationEvidence);
    expect(evidence.omissions).toBe(1);
    expect(evidence.unknownChanges).toBe(1);
    expect(evidence.added + evidence.modified + evidence.removed).toBe(0);
    const page = await readMutationEvidenceFiles(evidence, 0, 10, async hash => contentNodes.get(hash) ?? null);
    if (page.kind !== "available") throw new Error("omission is unavailable");
    expect(page.files).toEqual([{ kind: "omitted", path: memoryFile(), displayPath: memoryFile(), reason: "sensitive" }]);
    expect(JSON.stringify([...contentNodes.values()])).not.toContain(secret);
    expect(recorded.map(fact => fact.type)).toEqual(["memory.written"]);
  });

  it("records no audit fact and carries no artifact for a net-zero batch", async () => {
    const tool = makeTool();
    await tool.execute({ title: "Save a preference", action: "add", target: "project", content: "Original." }, makeContext());
    const recordedBefore = recorded.length;

    const result = await tool.execute({
      title: "Cancel a memory edit",
      target: "project",
      operations: [
        { action: "replace", old_text: "Original", content: "Temporary." },
        { action: "replace", old_text: "Temporary", content: "Original." },
      ],
    }, makeContext());

    expect(result.outcome).toBe("ok");
    expect(result.details).toBeUndefined();
    expect(recorded).toHaveLength(recordedBefore);
  });
});

/** The capability boundary one memory call passes (ARCH-TOOLS-001). The gate lives in
 *  the shared dispatcher, so these cases drive the real prepare-plus-execute
 *  path and prove the refusal lands before the store file exists. */
describe("memory tool under capability policy", () => {
  const WRITE = { title: "Save a preference", action: "add", target: "project", content: "Prefers concise replies." };

  function dispatch(capabilityAccess: CapabilityAccess): Promise<{ outcome: string; content: string | object }> {
    const tools = new Map<string, RuntimeTool>([["memory", makeTool()]]);
    const prepared = prepareToolCall({ id: "memory-call", name: "memory", input: WRITE }, tools);
    return executePreparedTool(prepared, { ...makeContext(), capabilityAccess });
  }

  it("refuses a stale call before anything is written to the store", async () => {
    const result = await dispatch(access([]));

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml");
    expect(existsSync(memoryFile())).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it("writes for an admitted review whose grant outlives the disable", async () => {
    const result = await dispatch(access([], { operation: "the self-improvement review", required: ["learning"], moduleIds: ["learning"], capabilities: ["learning"], requireWorkflowConfirmation: true, workflowsMode: "off", identity: "learning" }));

    expect(result.outcome).toBe("ok");
    expect(readFileSync(memoryFile(), "utf8")).toContain("concise");
  });
});