import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch, parsePatch } from "diff";
import { tmpdir } from "node:os";
import type { StoredFact } from "../../../../src/infra/event-store-types.js";
import { buildMutationDiff } from "../../../../src/infra/mutation-diff.js";
import { buildSessionChildLinkedFact, buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js";
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js";
import { buildArtifactContext, type ArtifactContextDeps } from "../../../../src/orchestration/workflow-host/artifact-context.js";
import type { ArtifactWriter } from "../../../../src/workflows/context-bundle/attempt-artifacts.js";
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js";
import { createContextAccumulator } from "../../../../src/workflows/context-bundle/context.js";
import { deps } from "../../workflows/vm/attempt-runner-test-support.js";
import { createMemoryStore, initialFacts, testHost } from "../../workflows/vm/host-test-support.js";
import { digest, fixture, row, timestamp } from "../session/_session-change-fixtures.js";

function observeFileAcquisition() {
  const acquired = new Map<string, number>();
  const originalFile = Bun.file;
  const fileSpy = spyOn(Bun, "file").mockImplementation((path, options) => {
    const file = typeof path === "number" ? originalFile(path, options)
      : typeof path === "string" || path instanceof URL ? originalFile(path, options)
      : originalFile(path, options);
    const text = file.text.bind(file);
    const slice = file.slice.bind(file);
    const record = (bytes: number) => acquired.set(String(path), (acquired.get(String(path)) ?? 0) + bytes);
    file.text = async () => {
      const result = await text();
      record(Buffer.byteLength(result));
      return result;
    };
    file.slice = (start?: number | string, end?: number | string, type?: string) => {
      const window = typeof start === "string" ? slice(start)
        : typeof end === "string" ? slice(start, end) : slice(start, end, type);
      record(window.size);
      return window;
    };
    return file;
  });
  return { acquired, fileSpy };
}

/** A writer with no recorded conversation: only its handoff's files show. */
const named = (handoff: ArtifactWriter["handoffs"][number]): ArtifactWriter => ({ agentName: "Previous", conversationIds: [], handoffs: [handoff] });

describe("buildArtifactContext", () => {
  let root: string;
  let store: ReturnType<typeof fixture>;
  let position: number;
  const callOwners = new Map<string, string>();
  let currentMember = "s";

  const contextDeps = (): ArtifactContextDeps => ({ executionCwd: root, projectRoot: root, reader: store.projectionReader, workflowId: "s" });
  const append = (fact: Omit<StoredFact, "position" | "id" | "seq">): void => {
    position += 1;
    store.rows.push({ ...fact, position, id: `fact-${position}`, seq: position });
  };
  const at = (type: string, payload: StoredFact["payload"], version = 1, aggregateId = `session:${currentMember}`) => {
    const { position: _position, id: _id, seq: _seq, ...fact } = row(0, type, payload, version, aggregateId);
    append({ ...fact, sessionId: aggregateId.startsWith("session:") ? aggregateId.slice("session:".length) : fact.sessionId });
  };
  const metadata = (sessionId: string, fact: Parameters<typeof buildSessionMetadataAppend>[1]): void => {
    append({ ...buildSessionMetadataAppend(sessionId, fact, 0), actor: "flywheel" });
  };

  /** A subagent session that one call of its parent launched, linked to the
   *  parent as the session manager publishes it. */
  function subagent(sessionId: string, parentSessionId: string, toolUseId: string, label: string): void {
    const parent = callOwners.get(toolUseId) ?? parentSessionId;
    metadata(sessionId, buildSessionCreatedFact({
      kind: "subagent", command: "subagent", conversationId: `c-${sessionId}`, label,
      lifecycleState: "inactive", lastUpdated: timestamp, executionCwd: root,
      launchedFrom: { parentSessionId: parent, toolUseId },
    }));
    metadata(parent, buildSessionChildLinkedFact(sessionId, timestamp));
  }

  /** One step conversation whose assistant turn made these tool calls. */
  function conversation(conversationId: string, toolUseIds: readonly string[]): void {
    currentMember = `member-${conversationId}`;
    for (const toolUseId of toolUseIds) callOwners.set(toolUseId, currentMember);
    metadata(currentMember, buildSessionCreatedFact({
      kind: "workflow-agent", command: "workflow-agent", conversationId, label: conversationId,
      lifecycleState: "inactive", lastUpdated: timestamp,
      launchedFrom: { parentSessionId: "chat", toolUseId: "launch" },
      workflowMembership: { kind: "attempt", workflowId: "s", attemptId: `attempt-${conversationId}` },
    }));
    at("chat.tree.created", { conversationId, createdAt: timestamp }, 1, `conversation:${conversationId}`);
    at("chat.entries.appended", {
      conversationId,
      entries: [{
        kind: "message", id: `assistant-${conversationId}`, parentId: null, timestamp,
        message: { kind: "assistant", content: toolUseIds.map((id) => ({ type: "tool_use", id, name: "edit", input: {} })) },
      }],
    }, 3, `conversation:${conversationId}`);
  }

  /** One recorded file mutation of a tool call. Its diff holds only this
   *  call's own change, as the shared file edit publisher records it. `diff`
   *  places the call's diff in its result, in a settled command's output
   *  record, or nowhere. */
  function edit(toolUseId: string, path: string, before: string | null, after: string | null, options: {
    readonly diff?: "result" | "execution_output" | "none";
    readonly parentToolUseId?: string;
    /** The session that recorded the edit: a child session for a subagent's edit. */
    readonly sessionId?: string;
  } = {}): void {
    const aggregateId = `session:${options.sessionId ?? callOwners.get(toolUseId) ?? currentMember}`;
    const mutation = buildMutationDiff([{
      path,
      before: before === null ? { kind: "absent" } : { kind: "text", text: before },
      after: after === null ? { kind: "absent" } : { kind: "text", text: after },
    }]);
    at("file.changed", {
      mutationId: `m-${position + 1}`, operationId: toolUseId,
      origin: { kind: "tool_call", toolUseId, ...(options.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}) },
      path: join(root, path), displayPath: path,
      changeKind: before === null ? "created" : after === null ? "deleted" : "modified",
      before: before === null ? null : digest(before), after: after === null ? null : digest(after),
    }, 3, aggregateId);
    const diff = options.diff ?? "result";
    if (diff === "result") at("tool.result.recorded", { toolUseId, outcome: "ok", details: { mutation } }, 1, aggregateId);
    if (diff === "execution_output") at("tool.execution_output.recorded", { toolUseId, output: "landed", mutation }, 1, aggregateId);
  }

  function edits(context: string | null, agentName: string): string {
    const section = context?.split(`## File Edits by Agent "${agentName}"\n\n`)[1];
    if (section === undefined) throw new Error(`No edits part for ${agentName}`);
    return section.split("\n\n## ")[0]!;
  }

  function current(context: string | null): string {
    const section = context?.split("## Current Files")[1];
    if (section === undefined) throw new Error("No current files part");
    return section;
  }

  beforeEach(() => {
    root = realpathSync(tmpdir());
    root = join(root, `flywheel-artifact-context-${crypto.randomUUID()}`);
    mkdirSync(join(root, "src"), { recursive: true });
    store = fixture([]);
    position = 0;
    callOwners.clear();
    currentMember = "s";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("two lanes that edit one shared file each see only their own hunks", async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const original = `${lines.join("\n")}\n`;
    const afterA = original.replace("line 1\n", "lane a line\n");
    const afterB = afterA.replace("line 12\n", "lane b line\n");
    conversation("c-a", ["tool-a"]);
    conversation("c-b", ["tool-b"]);
    edit("tool-a", "src/shared.ts", original, afterA);
    edit("tool-b", "src/shared.ts", afterA, afterB);
    writeFileSync(join(root, "src", "shared.ts"), afterB);
    const handoffs = [{ files_modified: ["src/shared.ts"] }];

    const laneB = await buildArtifactContext([{ agentName: "Lane b", conversationIds: ["c-b"], handoffs }], contextDeps(), new AbortController().signal);
    expect(edits(laneB, "Lane b")).toContain("+lane b line");
    expect(edits(laneB, "Lane b")).toContain("-line 12");
    expect(edits(laneB, "Lane b")).not.toContain("+lane a line");
    expect(current(laneB)).toContain("lane a line\n");

    const laneA = await buildArtifactContext([{ agentName: "Lane a", conversationIds: ["c-a"], handoffs }], contextDeps(), new AbortController().signal);
    expect(edits(laneA, "Lane a")).toContain("+lane a line");
    expect(edits(laneA, "Lane a")).not.toContain("+lane b line");
  });

  test("a person's uncommitted edit made before the workflow is current state, never a step's change", async () => {
    const before = "export const person = 'PERSON_EDIT';\nexport const value = 1;\n";
    const after = before.replace("value = 1", "value = 2");
    conversation("c-step", ["tool-1"]);
    edit("tool-1", "src/value.ts", before, after);
    writeFileSync(join(root, "src", "value.ts"), after);

    const context = await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [{ files_modified: ["src/value.ts"] }] }], contextDeps(), new AbortController().signal);
    expect(edits(context, "Implement")).toContain("+export const value = 2;");
    expect(edits(context, "Implement")).not.toContain("+export const person");
    expect(current(context)).toContain("Each file below is its current state. Other work can also have changed it since the agents above edited it.");
    expect(current(context)).toContain("#### src/value.ts\n```ts\nexport const person = 'PERSON_EDIT';");
  });

  test("shows a declared Bash command's landed edits and a nested call's edits as the step's own", async () => {
    conversation("c-step", ["bash-1", "container-1"]);
    edit("bash-1", "src/generated.ts", null, "export const generated = true;\n", { diff: "execution_output" });
    edit("nested-1", "src/nested.ts", null, "export const nested = true;\n", { parentToolUseId: "container-1" });
    edit("other-session-tool", "src/foreign.ts", null, "FOREIGN\n");

    const context = await buildArtifactContext([{ agentName: "Generate", conversationIds: ["c-step"], handoffs: [{ summary: "done" }] }], contextDeps(), new AbortController().signal);
    const part = edits(context, "Generate");
    expect(part).toContain("diff --git a/src/generated.ts b/src/generated.ts\n--- /dev/null\n+++ b/src/generated.ts\n@@ -0,0 +1,1 @@\n+export const generated = true;");
    expect(part).toContain("+export const nested = true;");
    expect(context).not.toContain("FOREIGN");
  });

  test("shows the edits of a subagent that the step launched as the step's own, named, in recorded order", async () => {
    conversation("c-step", ["tool-own", "launch-1"]);
    subagent("child-1", "s", "launch-1", "Explorer");
    edit("tool-own", "src/own.ts", null, "OWN_EDIT\n");
    edit("child-tool-1", "src/delegated.ts", null, "SUBAGENT_EDIT\n", { sessionId: "child-1" });
    writeFileSync(join(root, "src", "delegated.ts"), "SUBAGENT_EDIT\n");

    const context = await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal);
    const part = edits(context, "Implement");
    expect(part).toContain("# via subagent Explorer\ndiff --git a/src/delegated.ts b/src/delegated.ts\n--- /dev/null\n+++ b/src/delegated.ts\n@@ -0,0 +1,1 @@\n+SUBAGENT_EDIT");
    expect(part).toContain("```diff\ndiff --git a/src/own.ts b/src/own.ts\n");
    expect(part.indexOf("+OWN_EDIT")).toBeLessThan(part.indexOf("+SUBAGENT_EDIT"));
    expect(current(context)).toContain("#### src/delegated.ts\n```ts\nSUBAGENT_EDIT");
  });

  test("never shows the edits that a sibling lane's subagent made to the same file", async () => {
    const original = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const afterA = original.replace("line 1\n", "lane a line\n");
    const afterB = afterA.replace("line 12\n", "lane b line\n");
    conversation("c-a", ["launch-a"]);
    conversation("c-b", ["launch-b"]);
    subagent("child-a", "s", "launch-a", "Helper a");
    subagent("child-b", "s", "launch-b", "Helper b");
    edit("child-a-tool", "src/shared.ts", original, afterA, { sessionId: "child-a" });
    edit("child-b-tool", "src/shared.ts", afterA, afterB, { sessionId: "child-b" });

    const laneB = edits(await buildArtifactContext([{ agentName: "Lane b", conversationIds: ["c-b"], handoffs: [] }], contextDeps(), new AbortController().signal), "Lane b");
    expect(laneB).toContain("# via subagent Helper b\n");
    expect(laneB).toContain("+lane b line");
    expect(laneB).not.toContain("lane a line");
    expect(laneB).not.toContain("Helper a");

    const laneA = edits(await buildArtifactContext([{ agentName: "Lane a", conversationIds: ["c-a"], handoffs: [] }], contextDeps(), new AbortController().signal), "Lane a");
    expect(laneA).toContain("+lane a line");
    expect(laneA).not.toContain("lane b line");
  });

  test("shows the edits of a child that the step's subagent launched", async () => {
    conversation("c-step", ["launch-1"]);
    subagent("child-1", "s", "launch-1", "Planner");
    subagent("grandchild-1", "child-1", "child-launch", "Searcher");
    edit("grandchild-tool", "src/nested.ts", null, "GRANDCHILD_EDIT\n", { sessionId: "grandchild-1" });

    const part = edits(await buildArtifactContext([{ agentName: "Plan", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal), "Plan");
    expect(part).toContain("# via subagent Searcher\ndiff --git a/src/nested.ts b/src/nested.ts");
    expect(part).toContain("+GRANDCHILD_EDIT");
  });

  test("says in one line that a launched session's edits or a linked session could not be read", async () => {
    conversation("c-step", ["launch-1"]);
    subagent("child-1", "s", "launch-1", "Explorer");
    at("file.changed", { unreadable: true }, 3, "session:child-1");
    edit("child-tool", "src/kept.ts", null, "KEPT\n", { sessionId: "child-1" });
    // A linked child whose own metadata does not read: its launching call is unknown.
    metadata(currentMember, buildSessionChildLinkedFact("unreadable-child", timestamp));

    const context = await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal);
    const part = edits(context, "Implement");
    expect(part).toContain("+KEPT");
    expect(part).toContain("Partial evidence: 1 recorded file edit of subagent Explorer could not be read.");
    expect(context).toContain("Partial evidence: 1 child sessions of this agent could not be read.");
  });

  test("an inherited artifact's writer and the prior step each show only their own edits", async () => {
    conversation("c-implement", ["tool-implement"]);
    conversation("c-review", ["tool-review"]);
    edit("tool-implement", "src/feature.ts", null, "IMPLEMENTED\n");
    edit("tool-review", "src/review.md", null, "REVIEWED\n");

    const context = await buildArtifactContext([
      { agentName: "Review", conversationIds: ["c-review"], handoffs: [{ summary: "reviewed" }] },
      { agentName: "Implement", conversationIds: ["c-implement"], handoffs: [{ files_modified: ["src/feature.ts"] }] },
    ], contextDeps(), new AbortController().signal);
    expect(edits(context, "Review")).toContain("+REVIEWED");
    expect(edits(context, "Review")).not.toContain("IMPLEMENTED");
    expect(edits(context, "Implement")).toContain("+IMPLEMENTED");
    expect(edits(context, "Implement")).not.toContain("REVIEWED");
    expect(context!.indexOf("## File Edits by Agent \"Review\"")).toBeLessThan(context!.indexOf("## File Edits by Agent \"Implement\""));
  });

  test("shows each edit of one file as its own diff, and the diffs apply in recorded order", async () => {
    const original = `${Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const first = original.replace("line 5\n", "FIRST\n");
    const second = first.replace("line 6\n", "SECOND\n");
    conversation("c-step", ["tool-1", "tool-2"]);
    edit("tool-1", "src/a.ts", original, first);
    edit("tool-2", "src/a.ts", first, second);

    const part = edits(await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal), "Implement");
    expect(part).toContain("Each diff is one recorded edit against the file as that edit found it, in recorded order.");
    const series = part.split("```diff\n")[1]!.split("\n```")[0]!;
    const patches = parsePatch(series);
    expect(patches).toHaveLength(2);
    const applied = patches.reduce<string | false>((text, patch) => text === false ? false : applyPatch(text, patch), original);
    expect(applied).toBe(second);
  });

  test("shows the edits of every conversation of a writer attempt", async () => {
    // A resume after a context overflow runs the same attempt in a new conversation.
    conversation("c-before-overflow", ["tool-before"]);
    conversation("c-after-overflow", ["tool-after"]);
    edit("tool-before", "src/before.ts", null, "BEFORE_OVERFLOW\n");
    edit("tool-after", "src/after.ts", null, "AFTER_OVERFLOW\n");

    const part = edits(await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-before-overflow", "c-after-overflow"], handoffs: [] }], contextDeps(), new AbortController().signal), "Implement");
    expect(part).toContain("+BEFORE_OVERFLOW");
    expect(part).toContain("+AFTER_OVERFLOW");
    expect(part.indexOf("+BEFORE_OVERFLOW")).toBeLessThan(part.indexOf("+AFTER_OVERFLOW"));
  });

  test("shows the retained lines of a long diff and says how many lines it omits", async () => {
    conversation("c-step", ["tool-1"]);
    edit("tool-1", "src/big.ts", null, Array.from({ length: 1_200 }, (_, index) => `line ${index}\n`).join(""));

    const part = edits(await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal), "Implement");
    expect(part).toContain("+line 0\n");
    expect(part).not.toContain("Not retained");
    expect(part).toContain("Truncated: the diff of 1 recorded edit to src/big.ts omits its last 200 lines.");
  });

  test("says in one line that a recorded edit's diff held a credential", async () => {
    conversation("c-step", ["tool-1"]);
    edit("tool-1", "src/env.ts", null, "export const key = 'AKIAABCDEFGHIJKLMNOP';\n");

    const part = edits(await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal), "Implement");
    expect(part).not.toContain("AKIA");
    expect(part.split("\n").filter((line) => line.includes("src/env.ts"))).toEqual(["Omitted: the diff of 1 recorded edit to src/env.ts, because it holds a recognized credential."]);
  });

  test("bounds the notices of many edits whose diff text is not retained", async () => {
    const toolUseIds = Array.from({ length: 3_000 }, (_, index) => `tool-${index}`);
    conversation("c-step", toolUseIds);
    for (const [index, toolUseId] of toolUseIds.entries()) edit(toolUseId, `src/pruned-${index}.ts`, null, "PRUNED\n", { diff: "none" });

    const context = await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal);
    expect(Buffer.byteLength(context!)).toBeLessThanOrEqual(120_000);
    expect(edits(context, "Implement")).toMatch(/\nNot shown: \d+ more notices about the diffs of recorded edits\.$/);
  });

  test("says that a conversation batch of a writer could not be read", async () => {
    conversation("c-step", ["tool-1"]);
    at("chat.entries.appended", { conversationId: "c-step", entries: [{ kind: "unreadable" }] }, 3, "conversation:c-step");
    edit("tool-1", "src/a.ts", null, "KEPT\n");

    const part = edits(await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal), "Implement");
    expect(part).toContain("+KEPT");
    expect(part).toContain("Partial evidence: 1 recorded batch of this agent's conversations could not be read, so its edits are not shown.");
  });

  test("says in one line that a recorded edit's diff text is not retained", async () => {
    conversation("c-step", ["tool-1", "tool-2"]);
    edit("tool-1", "src/a.ts", "one\n", "PRUNED\n");
    edit("tool-2", "src/b.ts", "one\n", "KEPT\n");
    // Retention removed the first call's result, which held its diff.
    store.rows.splice(store.rows.findIndex((fact) => fact.type === "tool.result.recorded" && fact.payload.toolUseId === "tool-1"), 1);

    const part = edits(await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [] }], contextDeps(), new AbortController().signal), "Implement");
    expect(part).toContain("+KEPT");
    expect(part).not.toContain("PRUNED");
    expect(part.split("\n").filter((line) => line.includes("src/a.ts"))).toEqual(["Not retained: the diff of 1 recorded edit to src/a.ts."]);
  });

  test("gives a step that recorded no edit no diff part and skips Flywheel's own files", async () => {
    conversation("c-step", ["tool-note"]);
    edit("tool-note", ".flywheel/sessions/s/scratch/notes/n.md", null, "NOTE\n");
    writeFileSync(join(root, "src", "read.ts"), "READ_ONLY\n");

    const context = await buildArtifactContext([{ agentName: "Plan", conversationIds: ["c-step"], handoffs: [{ files_modified: ["src/read.ts"] }] }], contextDeps(), new AbortController().signal);
    expect(context).not.toContain("## File Edits");
    expect(context).not.toContain("NOTE");
    expect(current(context)).toContain("READ_ONLY");
  });

  test("includes content for repo-relative and absolute artifact paths in the execution directory", async () => {
    writeFileSync(join(root, "src", "safe.ts"), "export const marker = 'SAFE';\n");
    writeFileSync(join(root, "src", "absolute.ts"), "export const marker = 'ABSOLUTE_SAFE';\n");

    const context = await buildArtifactContext([named({
      files_modified: ["src/safe.ts", join(root, "src", "absolute.ts")],
    })], contextDeps(), new AbortController().signal);

    expect(context).toContain("#### src/safe.ts\n```ts\nexport const marker = 'SAFE';");
    expect(context).toContain("#### src/absolute.ts\n```ts\nexport const marker = 'ABSOLUTE_SAFE';");
  });

  test("reads a named file whose name starts with a colon or a tilde, and skips a name with a NUL byte", async () => {
    // Windows forbids a colon in a file name, so only a POSIX host can hold the colon file.
    const colon = process.platform !== "win32";
    if (colon) writeFileSync(join(root, ":colon.ts"), "COLON\n");
    mkdirSync(join(root, "~"));
    writeFileSync(join(root, "~", "tilde.ts"), "TILDE\n");
    const context = await buildArtifactContext([named({
      files_modified: [":colon.ts", "~/tilde.ts", "src/\0nul.ts"],
    })], contextDeps(), new AbortController().signal);

    if (colon) expect(context).toContain("#### :colon.ts\n```ts\nCOLON");
    expect(context).toContain("#### ~/tilde.ts\n```ts\nTILDE");
    expect(context).not.toContain("nul.ts");
  });

  test("deduplicates files across writers", async () => {
    writeFileSync(join(root, "src", "safe.ts"), "export const marker = 'ONCE';\n");
    const context = await buildArtifactContext([
      named({ files_modified: ["src/safe.ts"] }),
      { agentName: "Other", conversationIds: [], handoffs: [{ files_modified: ["./src/safe.ts"] }] },
    ], contextDeps(), new AbortController().signal);
    expect(context?.match(/#### src\/safe\.ts/g)).toHaveLength(1);
  });

  // The step after implement reads the implement output, whose envelope
  // lists the changed files beside the step's own declared fields.
  test("reads the envelope file list beside declared fields", async () => {
    writeFileSync(join(root, "src", "safe.ts"), "export const marker = 'ENVELOPE';\n");
    const context = await buildArtifactContext([named({
      summary: "Implemented the phase.",
      commands_run: [{ toolUseId: "toolu_1", exitCode: 0, observation: "3 tests passed", command: "bun test" }],
      files_modified: ["src/safe.ts"],
      phase_id: "p1",
    })], contextDeps(), new AbortController().signal);
    expect(context).toContain("#### src/safe.ts\n```ts\nexport const marker = 'ENVELOPE';");
  });

  test("ignores an output whose file list has the wrong shape", async () => {
    writeFileSync(join(root, "src", "safe.ts"), "SAFE");
    const context = await buildArtifactContext([named({ summary: "Done.", files_modified: "src/safe.ts" })], contextDeps(), new AbortController().signal);
    expect(context).toBeNull();
  });

  // A work handoff stored before the step output envelope listed its files
  // under `artifacts` and its test summary under `verification`.
  test("reads the files of a stored previous-shape work handoff and omits its test summary", async () => {
    writeFileSync(join(root, "src", "created.ts"), "CREATED");
    writeFileSync(join(root, "src", "changed.ts"), "CHANGED");
    const context = await buildArtifactContext([named({
      outcome: "completed",
      artifacts: { files_created: ["src/created.ts"], files_modified: ["src/changed.ts"] },
      verification: { test_output_summary: "PREVIOUS_TEST_SUMMARY" },
    })], contextDeps(), new AbortController().signal);
    expect(context).toContain("#### src/created.ts");
    expect(context).toContain("CREATED");
    expect(context).toContain("#### src/changed.ts");
    expect(context).toContain("CHANGED");
    expect(context).not.toContain("Test Results");
    expect(context).not.toContain("PREVIOUS_TEST_SUMMARY");
  });

  test("host disposal joins aborted artifact preparation before flushing the conversation", async () => {
    conversation("c-previous", []);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const capture = store.projectionReader.capturePosition.bind(store.projectionReader);
    store.projectionReader.capturePosition = async () => {
      started.resolve();
      await release.promise;
      return capture();
    };
    const context = createContextAccumulator();
    context.seedInput({ workflowDefinitionId: "host-test", userRequest: "review files", timestamp: 1 });
    context.accumulate({
      entryId: "previous", agentName: "Previous", definitionId: "previous",
      workflowDefinitionId: "host-test", recipientAttemptId: null, timestamp: 2,
      writes: [{ id: "files", lifetime: "transient" }],
      handoff: { files_modified: ["src/safe.ts"] },
    });
    const order: string[] = [];
    const host = testHost(createMemoryStore(initialFacts()), {
      attemptRunner: createAttemptExecutor(deps({
        context: { getContext: async () => context.getContext() },
        buildArtifactContext: (writers, signal) => buildArtifactContext(writers.map((writer) => ({ ...writer, conversationIds: ["c-previous"] })), contextDeps(), signal),
        recordInvocation: async () => { order.push("invocation"); },
        worker: async () => { throw new Error("worker must not start"); },
      })),
      lifecycle: { flushConversation: () => { order.push("flushed"); } },
    });
    const running = host.run();
    await started.promise;
    expect(await host.abort("stop preparing")).toBe(true);
    expect((await running).kind).toBe("paused");
    const disposing = host.dispose();
    await Promise.resolve();
    expect(order).toEqual([]);
    release.resolve();
    expect(await disposing).toEqual({ kind: "disposed" });
    expect(order).toEqual(["flushed"]);
  });

  test("bounds acquisition and UTF-8 output for 24 large edited files", async () => {
    const files = Array.from({ length: 24 }, (_, index) => `src/文件-${index}.ts`);
    conversation("c-step", files.map((_, index) => `tool-${index}`));
    for (const [index, file] of files.entries()) {
      const text = "\u{1f642}".repeat(16_384);
      edit(`tool-${index}`, file, null, "\u{1f642}\n".repeat(700));
      writeFileSync(join(root, file), text);
    }
    const { acquired, fileSpy } = observeFileAcquisition();
    try {
      const context = await buildArtifactContext([{ agentName: "Implement", conversationIds: ["c-step"], handoffs: [{ files_modified: files }] }], contextDeps(), new AbortController().signal);
      expect(context).not.toBeNull();
      expect(Buffer.byteLength(context!)).toBeLessThanOrEqual(120_000);
      expect(context).not.toContain("�");
      expect(acquired.size).toBeGreaterThan(0);
      expect(acquired.size).toBeLessThan(24);
      expect(context).toMatch(/## Current Files \(\d+\/24 shown\)/);
      expect([...acquired.values()].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(120_000);
      for (const [path, bytes] of acquired) {
        expect(bytes).toBeLessThanOrEqual(8_000);
        expect(context).toContain(`#### ${path.slice(root.length + 1).replaceAll("\\", "/")}`);
      }
      for (const section of context!.split("```ts\n").slice(1)) {
        const text = section.split("\n```")[0]!;
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8_000);
        expect(text).toMatch(/^\u{1f642}+\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\u{1f642}+$/u);
        const omitted = Number(text.match(/(\d+) bytes omitted/)?.[1]);
        expect(Buffer.byteLength(text.replace(/\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/, "")) + omitted).toBe(65_536);
      }
      const diff = context!.split("```diff\n")[1]?.split("\n```")[0];
      expect(Buffer.byteLength(diff ?? "")).toBeLessThanOrEqual(60_000);
      expect(diff).toMatch(/\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
    } finally {
      fileSpy.mockRestore();
    }
  });

  test("shares one diff budget across writers and discloses what it omits", async () => {
    conversation("c-first", ["tool-first"]);
    conversation("c-second", ["tool-second"]);
    edit("tool-first", "src/first.ts", null, `${"a".repeat(45)}\n`.repeat(900));
    edit("tool-second", "src/second.ts", null, `${"b".repeat(45)}\n`.repeat(900));

    const context = await buildArtifactContext([
      { agentName: "First", conversationIds: ["c-first"], handoffs: [] },
      { agentName: "Second", conversationIds: ["c-second"], handoffs: [] },
    ], contextDeps(), new AbortController().signal);
    const diffs = context!.split("```diff\n").slice(1).map((part) => part.split("\n```")[0]!);
    expect(diffs).toHaveLength(2);
    expect(diffs.reduce((sum, diff) => sum + Buffer.byteLength(diff), 0)).toBeLessThanOrEqual(60_000);
    expect(diffs[0]).not.toContain("bytes omitted");
    expect(diffs[1]).toMatch(/\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
  });

  test("joins an admitted head read after abort without admitting a tail read", async () => {
    writeFileSync(join(root, "src", "safe.ts"), "a".repeat(65_536));
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalFile = Bun.file;
    let slices = 0;
    const fileSpy = spyOn(Bun, "file").mockImplementation((path, options) => {
      const file = typeof path === "number" ? originalFile(path, options)
        : typeof path === "string" || path instanceof URL ? originalFile(path, options)
        : originalFile(path, options);
      const slice = file.slice.bind(file);
      file.slice = (start?: number | string, end?: number | string, type?: string) => {
        slices++;
        const window = typeof start === "string" ? slice(start)
          : typeof end === "string" ? slice(start, end) : slice(start, end, type);
        const read = window.arrayBuffer.bind(window);
        window.arrayBuffer = async () => {
          started.resolve();
          await release.promise;
          return read();
        };
        return window;
      };
      return file;
    });
    try {
      const preparing = buildArtifactContext([named({
        files_modified: ["src/safe.ts"],
      })], contextDeps(), controller.signal);
      let settled = false;
      const outcome = preparing.then(() => "completed", () => "aborted").finally(() => { settled = true; });
      await started.promise;
      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      expect(await outcome).toBe("aborted");
      expect(slices).toBe(1);
    } finally {
      release.resolve();
      fileSpy.mockRestore();
    }
  });

  test("charges unreadable files against the aggregate acquisition budget", async () => {
    const files = Array.from({ length: 24 }, (_, index) => `src/invalid-${index}.ts`);
    for (const file of files) writeFileSync(join(root, file), Buffer.alloc(8_000, 0xff));
    const { acquired, fileSpy } = observeFileAcquisition();
    try {
      const context = await buildArtifactContext([named({
        files_modified: files,
      })], contextDeps(), new AbortController().signal);
      expect(context).toBeNull();
      expect(acquired.size).toBeGreaterThan(0);
      expect([...acquired.values()].reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(120_000);
      expect(acquired.size).toBeLessThan(files.length);
      for (const bytes of acquired.values()) expect(bytes).toBeLessThanOrEqual(8_000);
    } finally {
      fileSpy.mockRestore();
    }
  });
});
