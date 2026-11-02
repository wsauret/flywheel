import { describe, expect, it, spyOn } from "bun:test";
import { Schema } from "effect";

import * as controlCharacters from "../../../../src/infra/control-characters.js";
import { DELIVERY_CONFIRMATION } from "../../../../src/infra/delivery-confirmation.js";
import type { LlmToolOutputPart } from "../../../../src/infra/llm/tool-output-part-schema.js";
import type { AnyBlock, ToolEntry, AgentGroupBlock } from "../../../../src/infra/output-blocks.js";
import { extractDisplayMeta, resolveTrackedToolResult as resolveTrackedToolResultAtCwd } from "../../../../src/infra/output/structured-event-tool-results.js";
import type { PlacedTool } from "../../../../src/infra/output/output-tool-projection-types.js";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import { formatToolInputProblems } from "../../../../src/orchestration/agent-runtime/tools/validate-input.js";
import { RuntimeEventFrameSchema, RuntimeUiPatchSchema } from "../../../../src/protocol/runtime-protocol-schemas.js";
import type { ToolOutcome } from "../../../../src/infra/tool-outcome.js";

function textContent(text: string): LlmToolOutputPart[] {
  return [{ type: "text", text }];
}

function resolveTrackedToolResult(
  builder: StructuredOutputBuilder,
  tracked: PlacedTool,
  toolUseId: string,
  outcome: ToolOutcome,
  rawContent?: LlmToolOutputPart[],
  details?: unknown,
  executionOutputTail?: string,
): void {
  resolveTrackedToolResultAtCwd(builder, tracked, toolUseId, outcome, "/workspace", rawContent, details, executionOutputTail);
}

function agentBlock(builder: StructuredOutputBuilder): AgentGroupBlock {
  const block = builder.getBlocks()[0];
  if (block?.kind !== "agentGroup") throw new Error("expected agent group block");
  return block;
}

function toolBlock(builder: StructuredOutputBuilder): ToolEntry {
  const block = builder.getBlocks()[0];
  if (block?.kind !== "tool") throw new Error("expected tool block");
  return block;
}

function outputPatch(block: AnyBlock) {
  return {
    cursor: { scope: "session", domain: "output", sessionId: "s1" },
    position: 1,
    prevPosition: 0,
    payload: {
      kind: "output.delta",
      delta: { visibleMessageCount: 0, blocks: [{ kind: "upsert", index: 0, blockId: "tool:test", block }] },
    },
  } as const;
}

describe("resolveTrackedToolResult", () => {
  it.each([false, true])("keeps the handoff's first sentence when partial is %s", (partial) => {
    const builder = new StructuredOutputBuilder();
    builder.startAgent("agent", { containerKind: "subagent", label: "Explorer", description: "Trace" }, 1, "dispatch");
    resolveTrackedToolResult(builder, { kind: "agent", agentId: "agent", spawnedAt: 1, toolName: "subagent" }, "dispatch", "ok",
      textContent(JSON.stringify({ summary: "**Fixed** the issue. The tests pass." })), { partial });
    expect(agentBlock(builder)).toMatchObject({ status: partial ? "partial" : "completed", summary: "Fixed the issue" });
  });

  it.each(["plain result", "{}", '{"summary":42}'])("does not invent a summary from %s", (content) => {
    const builder = new StructuredOutputBuilder();
    builder.startAgent("agent", { containerKind: "subagent", label: "Explorer", description: "Trace" }, 1, "dispatch");
    resolveTrackedToolResult(builder, { kind: "agent", agentId: "agent", spawnedAt: 1, toolName: "subagent" }, "dispatch", "ok", textContent(content));
    expect(agentBlock(builder)).not.toHaveProperty("summary");
  });

  it("names a message's recipient from its result in place of the session id, whatever the outcome", () => {
    for (const outcome of ["ok", "error"] as const) {
      const builder = new StructuredOutputBuilder();
      builder.pushStandaloneToolEntry({ kind: "tool", id: "message-1", name: "message_session", presentation: { name: "Message to", detail: "3f2a-parent" }, timestamp: Date.now(), status: "pending" });
      resolveTrackedToolResult(builder, { kind: "standalone", toolName: "message_session", streamsInput: false }, "message-1", outcome, textContent("Held for 3f2a-parent."), { targetName: "Plan the\nrelease" });
      expect(toolBlock(builder).presentation).toEqual({ name: "Message to", detail: "Plan the release" });
    }
  });

  it("settles a message that its recipient holds as waiting, with the line its result states, in a standalone row and in a subagent card", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "message-1", name: "message_session", presentation: { name: "Message to", detail: "3f2a-parent" }, timestamp: Date.now(), status: "pending" });
    resolveTrackedToolResult(builder, { kind: "standalone", toolName: "message_session", streamsInput: false }, "message-1", "ok", textContent("Held for 3f2a-parent."), { targetName: "Plan", statusMessage: "Held: nothing runs it now." });
    expect(toolBlock(builder)).toMatchObject({ status: "blocked", statusMessage: "Held: nothing runs it now.", presentation: { detail: "Plan" } });

    const card = new StructuredOutputBuilder();
    card.startAgent("agent-1", { containerKind: "subagent", label: "Explorer", description: "Look" }, 1, "tu-agent-1");
    const childIndex = card.pushToolRowToAgent("agent-1", { kind: "tool", id: "child-message", name: "message_session", presentation: { name: "Message to", detail: "3f2a-parent" }, timestamp: 1, status: "pending" });
    resolveTrackedToolResult(card, { kind: "row", toolName: "message_session", agentId: "agent-1", childIndex, streamsInput: false, inSubagent: true }, "child-message", "ok", textContent("Held for 3f2a-parent."), { statusMessage: "Held: nothing runs it now." });
    const group = card.getBlocks().find((block) => block.kind === "agentGroup");
    expect(group?.kind === "agentGroup" ? group.children[childIndex] : undefined).toMatchObject({ status: "blocked", statusMessage: "Held: nothing runs it now." });
  });

  it("keeps background shell management text out of the row until command output is recorded", () => {
    for (const output of [undefined, "command output\n"]) {
      const builder = new StructuredOutputBuilder();
      builder.pushStandaloneToolEntry({ kind: "tool", id: "bash-background", name: "bash", presentation: { name: "Bash", detail: "Run command" }, timestamp: Date.now(), status: "pending" });
      const agentResult = textContent("Process moved to background. Use process wait.");
      resolveTrackedToolResult(builder, { kind: "standalone", toolName: "bash", streamsInput: false }, "bash-background", "ok", agentResult, { background: true }, output);
      expect(toolBlock(builder).status).toBe("completed");
      expect(toolBlock(builder).content).toBe(output);
      expect(agentResult).toEqual(textContent("Process moved to background. Use process wait."));
    }
  });

  it("shows a curated memory failure without exposing recovery data", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "memory-overflow", name: "memory", presentation: { name: "Memory", detail: "Save preference" }, timestamp: Date.now(), status: "pending" });
    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "memory", streamsInput: false },
      "memory-overflow",
      "error",
      textContent(JSON.stringify({ success: false, error: "Memory at 1,409/1,500 chars. Adding this entry (159 chars) would exceed the limit by 68 chars.", current_entries: ["Private memory."] })),
    );
    const tool = toolBlock(builder);
    if (tool.status !== "error") throw new Error("expected failed memory tool");
    expect(tool.errorMessage).toBe("Memory update exceeds the limit by 68 characters");
    expect(tool.content).toBeUndefined();
  });

  it("surfaces a clean auth explanation as the agent error detail, dropping the agent-instructional tail", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explorer", description: "Trace tab bar rendering" }, now, "tu-agent-1");

    const rawText =
      "Subagent 'explorer' failed: Authentication failed: the OpenAI API key was rejected. " +
      "Provider response: 401 Incorrect API key provided. " +
      "The runner exited before producing a result; either retry with a tighter scope, do the work directly.";
    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "error",
      textContent(rawText),
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("error");
    if (block.status !== "error") return;
    expect(block.failure.message).toContain("API key was rejected");
    expect(block.failure.detail ?? "").not.toContain("Provider response");
    expect(block.failure.guidance).not.toContain("retry with a tighter scope");
  });

  it("surfaces the failure reason for non-auth agent failures, dropping the instructional tail", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explorer", description: "Trace tab bar rendering" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "error",
      textContent("Subagent 'explorer' failed: rate limited. The runner exited before producing a result; either retry with a tighter scope."),
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("error");
    if (block.status !== "error") return;
    expect(block.failure.title).toBe("Rate limited");
    expect(block.failure.guidance).not.toContain("The runner exited");
  });

  it("turns a provider billing failure into an actionable subagent error", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Design Reviewer", description: "Review provider settings UX" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "error",
      textContent(
        "Subagent 'reviewer-code-design' (Review provider settings UX) failed: Out of credits: 402 This request requires more credits, or fewer max_tokens. " +
        "You requested up to 128000 tokens, but can only afford 124062. To increase, visit https://openrouter.ai/settings/credits and add more credits. " +
        "The runner exited before producing a result; either retry with a tighter scope, do the work directly, or surface the failure to the user if it indicates a deeper problem.",
      ),
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("error");
    if (block.status !== "error") return;
    expect(block.failure.title).toBe("Out of credits");
    expect(block.failure.guidance).toContain("/model");
    expect(block.failure.message).toContain("OpenRouter");
    expect(block.failure.message).toContain("128,000");
    expect(block.failure.detail).toContain("124,062");
  });

  it("surfaces a truncated detail for tool-level errors that match no special pattern", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Initializing…" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "error",
      textContent("subagent was called without a 'persona' string. Pick one of the registered agents: implementer."),
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("error");
    if (block.status !== "error") return;
    expect(block.failure.message).toContain("Subagent was called without");
  });

  it("uses raw failure evidence when structured failure metadata is blank", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Review the change" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "error",
      textContent(formatToolInputProblems("subagent", ["The required parameter `kind` is missing"])),
      {
        agentFailure: {
          title: "Subagent failed",
          message: "",
          guidance: "Send a message to retry. If it fails again, run /model.",
        },
      },
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("error");
    if (block.status !== "error") return;
    expect(block.failure).toEqual({
      title: "Subagent failed",
      message: "Invalid input: The required parameter `kind` is missing",
      guidance: "Correct the tool input and retry.",
    });
  });

  it("renders a cancelled agent as Canceled instead of an error", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explorer", description: "Trace cancellation" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "cancelled",
      textContent("Subagent was canceled by the requesting agent."),
    );

    expect(agentBlock(builder)).toMatchObject({ status: "cancelled", description: "Trace cancellation" });
  });

  it("renders an agent a person stopped as stopped, not as an error or a completion", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explorer", description: "Trace the stop" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "stopped",
      textContent("Subagent was stopped by the user."),
    );

    expect(agentBlock(builder)).toMatchObject({ status: "stopped", description: "Trace the stop" });
  });

  it("preserves a structured non-API provider failure", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Reviewer", description: "Review the change" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "error",
      textContent("Subagent 'reviewer' failed: Persistent provider overload after 10 recovery attempts: overloaded."),
      {
        agentFailure: {
          title: "Provider overloaded",
          message: "The model provider is temporarily overloaded. Nothing is wrong on your end.",
          guidance: "Send a message to retry, or switch models with /model.",
          detail: "Persistent provider overload after 10 recovery attempts: overloaded",
          action: { label: "Switch models", command: "/model" },
        },
      },
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("error");
    if (block.status !== "error") return;
    expect(block.failure.title).toBe("Provider overloaded");
    expect(block.failure.message).toContain("Nothing is wrong on your end");
  });

  it("stamps totalTokens from the tool_result details on agent completion", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Researching" }, now, "tu-agent-1");

    resolveTrackedToolResult(
      builder,
      { kind: "agent", agentId: "agent-1", spawnedAt: now, toolName: "subagent" },
      "toolu_agent",
      "ok",
      textContent("done"),
      { totalTokens: 48200 },
    );

    const block = agentBlock(builder);
    expect(block.status).toBe("completed");
    expect(block.totalTokens).toBe(48200);
  });

  it("drops the delivery receipt from display content: it is turn metadata, not tool output", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_bash", name: "bash", presentation: { name: "Bash", detail: "bun run lint" }, timestamp: Date.now(), status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "bash", streamsInput: false },
      "toolu_bash",
      "ok",
      [
        { type: "text", text: "lint passed" },
        { type: "text", text: DELIVERY_CONFIRMATION },
      ],
      { exitCode: 0 },
    );

    const tool = toolBlock(builder);
    expect(tool.content).toBe("lint passed");
  });

  it("sanitizes ANSI escapes out of preserved result content once before it reaches the display block", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_bash", name: "bash", presentation: { name: "Bash", detail: "make dbt-prod-state-local" }, timestamp: Date.now(), status: "pending" });
    // A result can be megabytes of text, so the finalized and the completed row share one sanitized body.
    const sanitize = spyOn(controlCharacters, "sanitizeExternalText");

    try {
      resolveTrackedToolResult(
        builder,
        { kind: "standalone", toolName: "bash", streamsInput: false },
        "toolu_bash",
        "ok",
        textContent("\u001b[0m03:36:30  Running with dbt=1.11.11\n\u001b[0m03:36:36  1 of 10 START \u001b[32m[RUN]\u001b[0m"),
        { exitCode: 0 },
      );
      expect(sanitize).toHaveBeenCalledTimes(1);
    } finally {
      sanitize.mockRestore();
    }

    const tool = toolBlock(builder);
    expect(tool.content).toBe("03:36:30  Running with dbt=1.11.11\n03:36:36  1 of 10 START [RUN]");
  });

  it("prefers the execution output tail for successful bash display content", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_bash", name: "bash", presentation: { name: "Bash", detail: "generate output" }, timestamp: Date.now(), status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "bash", streamsInput: false },
      "toolu_bash",
      "ok",
      textContent("compressed model result"),
      { exitCode: 0 },
      "settled \u001b[32mexecution\u001b[0m tail",
    );

    const tool = toolBlock(builder);
    expect(tool.content).toBe("settled execution tail");
  });

  it("falls back to result content when a successful bash has no execution output tail", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_bash", name: "bash", presentation: { name: "Bash", detail: "generate output" }, timestamp: Date.now(), status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "bash", streamsInput: false },
      "toolu_bash",
      "ok",
      textContent("compressed model result"),
      { exitCode: 0 },
    );

    const tool = toolBlock(builder);
    expect(tool.content).toBe("compressed model result");
  });

  it("settles a blocked (wait-state) result as a blocked row plus an injected system message with the full text", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_handoff", name: "handoff", presentation: { name: "Handoff", detail: "" }, timestamp: Date.now(), status: "pending" });

    const message = "handoff blocked: owned background work is still running or its result has not been incorporated.\nStill running: verifier. End your turn and wait for it or stop it before handoff.";
    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "handoff", streamsInput: false },
      "toolu_handoff",
      "blocked",
      textContent(message),
    );

    const blocks = builder.getBlocks();
    const tool = toolBlock(builder);
    expect(tool.status).toBe("blocked");
    if (tool.status !== "blocked") throw new Error("expected blocked tool");
    expect(tool.statusMessage).toBe("handoff blocked: owned background work is still running or its result has not been incorporated.");
    const notice = blocks[1];
    if (notice?.kind !== "userMessage") throw new Error("expected injected user message");
    expect(notice.injected).toBe(true);
    expect(notice.content).toBe(message);
  });

  it("settles a blocked child row inside an agent group without a system notice", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Working" }, now, "tu-agent-1");
    const childIndex = builder.pushToolRowToAgent("agent-1", { kind: "tool", id: "toolu_h", name: "handoff", presentation: { name: "Handoff", detail: "" }, timestamp: now, status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "row", agentId: "agent-1", childIndex, toolName: "handoff", streamsInput: false, inSubagent: true },
      "toolu_h",
      "blocked",
      textContent("handoff blocked: you called handoff before incorporating every subagent you dispatched.\nDetails follow."),
    );

    const blocks = builder.getBlocks();
    expect(blocks).toHaveLength(1);
    const group = agentBlock(builder);
    const child = group.children[0];
    if (child?.status !== "blocked") throw new Error("expected blocked child");
    expect(child.statusMessage).toBe("handoff blocked: you called handoff before incorporating every subagent you dispatched.");
  });


  it("preserves Code result content before settling every ordinary terminal outcome", () => {
    for (const outcome of ["error", "blocked", "interrupted", "cancelled"] as const) {
      const builder = new StructuredOutputBuilder();
      const toolUseId = `toolu_code_${outcome}`;
      builder.pushStandaloneToolEntry({ kind: "tool", id: toolUseId, name: "code", presentation: { name: "Code", detail: "" }, timestamp: Date.now(), status: "pending" });
      resolveTrackedToolResult(
        builder,
        { kind: "standalone", toolName: "code", streamsInput: false },
        toolUseId,
        outcome,
        textContent(`exact ${outcome} result`),
      );
      expect(toolBlock(builder).content).toBe(`exact ${outcome} result`);
      // "cancelled" renders as an error row: the call produced no result.
      expect(toolBlock(builder).status).toBe(outcome === "error" || outcome === "cancelled" ? "error" : outcome);
    }
  });
});

describe("canonical mutation artifacts", () => {
  const EVIDENCE = {
    version: 2,
    manifest: { version: 1, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
    applied: 5000, retainedFiles: 4999, omissions: 1, notApplied: 0, added: 0, modified: 5000, removed: 0,
    addedLines: 6000, removedLines: 4000, conflictMarkers: 0,
    samples: [{ kind: "applied", path: "/workspace/src/a.ts" }],
  } as const;

  it("projects bounded evidence without legacy patches, including failed settled prefixes", () => {
    for (const outcome of ["ok", "error", "interrupted"] as const) {
      const builder = new StructuredOutputBuilder();
      builder.pushStandaloneToolEntry({
        kind: "tool", id: "edit-evidence", name: "edit", presentation: { name: "Edit", detail: "src/a.ts" },
        timestamp: 1, status: "pending",
        proposedDiff: { files: [], unavailable: "malformed" },
      });
      resolveTrackedToolResult(builder, { kind: "standalone", toolName: "edit", streamsInput: false },
        "edit-evidence", outcome, textContent("settled"), { mutationEvidence: EVIDENCE, diff: "-secret\n+secret" });
      const tool = toolBlock(builder);
      expect(tool.mutationEvidence).toEqual({
        ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }],
      });
      expect(Object.hasOwn(tool, "mutation")).toBe(false);
      expect(tool.diff).toBeUndefined();
      expect(tool.proposedDiff).toBeUndefined();
      expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(
        Schema.encodeUnknownSync(RuntimeUiPatchSchema)(outputPatch(tool)))).toEqual(outputPatch(tool));
    }
  });

  it("keeps advisory previews separate and does not expose sensitive legacy content", () => {
    const identity = { source: "edit", toolUseId: "sensitive" };
    expect(extractDisplayMeta({ diff: "-advice\n+proposal" }, identity)).toEqual({ diff: "-advice\n+proposal" });
    const sensitive = { ...EVIDENCE, omissions: 5000, samples: [] };
    expect(extractDisplayMeta({ mutationEvidence: sensitive, files: [{ path: ".env", diff: "-secret\n+secret" }] }, identity))
      .toEqual({ mutationEvidence: sensitive });
    expect(() => extractDisplayMeta({ mutationEvidence: { ...EVIDENCE, samples: Array.from({ length: 4 }, () => EVIDENCE.samples[0]) } }, identity))
      .toThrow(/malformed mutationEvidence/);
  });

  it("keeps resolved skill scope beside mutation evidence on the completed row", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_m", name: "skill_manage", presentation: { name: "Save Skill", detail: "example" }, timestamp: Date.now(), status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "skill_manage", streamsInput: false },
      "toolu_m",
      "ok",
      textContent("Skill saved. Reach: global."),
      { mutationEvidence: EVIDENCE, resultAction: "created" },
    );

    const tool = toolBlock(builder);
    expect(tool.status).toBe("completed");
    expect(tool.mutationEvidence).toEqual({ ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }] });
    expect(tool.resultAction).toBe("created");
    expect(tool.content).toContain("Reach: global.");
    expect(tool.diff).toBeUndefined();
  });

  it("keeps the artifact of a nested learning write expandable on the child row", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Working" }, now, "tu-agent-1");
    const childIndex = builder.pushToolRowToAgent("agent-1", { kind: "tool", id: "toolu_m", name: "skill_manage", presentation: { name: "Save Skill", detail: "example" }, timestamp: now, status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "row", agentId: "agent-1", childIndex, toolName: "skill_manage", streamsInput: false, inSubagent: true },
      "toolu_m",
      "ok",
      textContent("{\"success\":true}"),
      { mutationEvidence: EVIDENCE, resultAction: "created", diff: "-a\n+b", filetype: "typescript" },
    );

    const group = agentBlock(builder);
    const child = group.children[0];
    expect(child?.status).toBe("completed");
    expect(child?.mutationEvidence).toEqual({ ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }] });
    expect(child?.resultAction).toBe("created");
    // Preview-bearing fields still stay out of a compact child row.
    expect(child?.diff).toBeUndefined();
    expect(child?.filetype).toBeUndefined();
    expect(Object.hasOwn(child ?? {}, "diff")).toBe(false);
    expect(Object.hasOwn(child ?? {}, "filetype")).toBe(false);
  });

  it("recognizes only the canonical artifact contract, and refuses a present shape that is not it", () => {
    const identity = { source: "skill_manage", toolUseId: "toolu_m" } as const;
    expect(extractDisplayMeta({ mutationEvidence: EVIDENCE }, identity).mutationEvidence).toEqual(EVIDENCE);
    // Absent is ordinary: most results publish no artifact at all.
    expect(extractDisplayMeta({ diff: "-a\n+b" }, identity).mutationEvidence).toBeUndefined();
    expect(extractDisplayMeta({}, identity).mutationEvidence).toBeUndefined();
    // Present but not the contract: a producer defect, named rather than dropped.
    for (const malformed of [{ ...EVIDENCE, version: 1 }, { manifest: EVIDENCE.manifest }, "a diff", null]) {
      expect(() => extractDisplayMeta({ mutationEvidence: malformed }, identity)).toThrow(/malformed mutationEvidence in skill_manage result details for toolu_m/);
    }
    expect(extractDisplayMeta({ resultAction: "invented" }, identity).resultAction).toBeUndefined();
  });

  it("uses the canonical mutation instead of a sensitive legacy diff", () => {
    const mutationEvidence = { ...EVIDENCE, applied: 0, retainedFiles: 0, omissions: 1, unknownChanges: 1, samples: [] };
    const meta = extractDisplayMeta({
      files: [{ path: ".env", diff: "-API_KEY=old\n+API_KEY=new", filetype: "text" }],
      mutationEvidence,
    }, { source: "edit", toolUseId: "toolu_sensitive" });

    expect(meta).toEqual({ mutationEvidence });
  });

  it("replaces an input-derived preview when successful details carry a verified mutation", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({
      kind: "tool",
      id: "toolu_verified",
      name: "edit",
      presentation: { name: "Edit", detail: "src/a.ts" },
      timestamp: Date.now(),
      status: "pending",
      diff: "-unverified\n+preview",
      filetype: "diff",
    });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "edit", streamsInput: false },
      "toolu_verified",
      "ok",
      textContent("done"),
      { mutationEvidence: EVIDENCE },
    );

    const tool = toolBlock(builder);
    expect(tool).toEqual(expect.objectContaining({
      status: "completed",
      mutationEvidence: { ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }] },
    }));
    expect(tool.diff).toBeUndefined();
    expect(tool.filetype).toBeUndefined();
    expect(tool.presentation).toEqual({ name: "Edit", detail: "src/a.ts" });
    expect(Object.hasOwn(tool, "diff")).toBe(false);
    expect(Object.hasOwn(tool, "filetype")).toBe(false);

    const patch = outputPatch(tool);
    expect(Schema.encodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch);
  });

  it("deletes explicitly cleared child preview keys while preserving absent patch fields", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Working" }, now, "tu-agent-1");
    const childIndex = builder.pushToolRowToAgent("agent-1", {
      kind: "tool",
      id: "toolu_m",
      name: "skill_manage",
      presentation: { name: "Save Skill", detail: "example" },
      timestamp: now,
      status: "pending",
      diff: "-unverified\n+preview",
      filetype: "diff",
    });

    const completion = {
      mutationEvidence: EVIDENCE,
      diff: undefined,
      filetype: undefined,
    };
    expect(Object.hasOwn(completion, "diff")).toBe(true);
    expect(Object.hasOwn(completion, "presentation")).toBe(false);
    builder.completeAgentChildTool("agent-1", childIndex, completion);

    const group = agentBlock(builder);
    const child = group.children[0];
    expect(child?.status).toBe("completed");
    expect(child?.presentation).toEqual({ name: "Save Skill", detail: "example" });
    expect(child?.diff).toBeUndefined();
    expect(child?.filetype).toBeUndefined();
    expect(Object.hasOwn(child ?? {}, "diff")).toBe(false);
    expect(Object.hasOwn(child ?? {}, "filetype")).toBe(false);

    const frame = { type: "patch", patch: outputPatch(group) } as const;
    expect(Schema.encodeUnknownSync(RuntimeEventFrameSchema)(frame)).toEqual(frame);
  });

  it("keeps the legacy per-file diff of an edit alongside an artifact-free result", () => {
    const meta = extractDisplayMeta({ files: [{ path: "src/a.ts", diff: "-a\n+b", filetype: "typescript" }] }, { source: "edit", toolUseId: "toolu_e" });
    expect(meta).toEqual({ diff: "-a\n+b", filetype: "typescript" });
  });
});
