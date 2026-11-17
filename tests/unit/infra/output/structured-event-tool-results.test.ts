import { describe, expect, it, spyOn } from "bun:test";

import * as controlCharacters from "../../../../src/infra/control-characters.js";
import { DELIVERY_CONFIRMATION } from "../../../../src/infra/delivery-confirmation.js";
import { resolveTrackedToolResult as resolveTrackedToolResultAtCwd } from "../../../../src/infra/output/structured-event-tool-results.js";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import { formatToolInputProblems } from "../../../../src/orchestration/agent-runtime/tools/validate-input.js";
import type { ToolOutcome } from "../../../../src/infra/tool-outcome.js";
import { agentBlock, resolveTrackedToolResult, textContent, toolBlock } from "./_tool-result-fixtures.js";

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

  it("names the chat that a route started from its result, and states when the call returned, once", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "route-1", name: "route_request", presentation: { name: "Route to new session", detail: "" }, timestamp: 1_000, status: "pending" });
    const result = textContent("Started chat 99b414b85fde \"New Chat\" with the person's messages.");
    resolveTrackedToolResultAtCwd(builder, { kind: "standalone", toolName: "route_request", streamsInput: false }, "route-1", "ok", "/workspace", result, { targetName: "New Chat", targetSessionId: "99b414b85fde" }, undefined, undefined, 1_400);
    expect(toolBlock(builder)).toMatchObject({ status: "completed", targetSessionId: "99b414b85fde", settledAt: 1_400, presentation: { detail: "New Chat" } });
    resolveTrackedToolResultAtCwd(builder, { kind: "standalone", toolName: "route_request", streamsInput: false }, "route-1", "ok", "/workspace", result, { targetName: "New Chat", targetSessionId: "99b414b85fde" }, undefined, undefined, 9_000);
    expect(toolBlock(builder).settledAt).toBe(1_400);
  });

  // ARCH-SUBSTRATE-017: settling a card's row reads that row through the card's index, so the work does not grow with
  // the rows before the card.
  it("states when a card's row returned, with block reads that do not grow with the transcript", () => {
    const blockReads = (before: number) => {
      const card = new StructuredOutputBuilder();
      for (let index = 0; index < before; index++) card.pushStandaloneToolEntry({ kind: "tool", id: `earlier-${index}`, name: "read", presentation: { name: "Read", detail: "a.ts" }, timestamp: 1, status: "completed" });
      card.startAgent("agent-1", { containerKind: "subagent", label: "Explorer", description: "Look" }, 1, "tu-agent-1");
      const childIndex = card.pushToolRowToAgent("agent-1", { kind: "tool", id: "child-read", name: "read", presentation: { name: "Read", detail: "b.ts" }, timestamp: 1_000, status: "pending" });
      const blocks = card.getBlocks();
      let reads = 0;
      const counted = new Proxy(blocks, {
        get: (target, key, receiver) => {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: a Proxy trap forwards an arbitrary property key to its target
          return Reflect.get(target, key, receiver);
        },
      });
      const getBlocks = spyOn(card, "getBlocks").mockImplementation(() => counted);
      resolveTrackedToolResultAtCwd(card, { kind: "row", toolName: "read", agentId: "agent-1", childIndex, streamsInput: false, inSubagent: true }, "child-read", "ok", "/workspace", textContent("b"), undefined, undefined, undefined, 2_400);
      getBlocks.mockRestore();
      expect(card.agentChildTool("agent-1", childIndex)).toMatchObject({ status: "completed", settledAt: 2_400 });
      return reads;
    };
    expect(blockReads(1_000)).toBe(blockReads(10));
  });

  // PI-AGENT-131: the result, never the empty input, says that a call read its tool's contract.
  it("presents a call as a read of its tool's contract only when its ok result states it", () => {
    const settle = (toolName: string, outcome: ToolOutcome, details?: unknown) => {
      const builder = new StructuredOutputBuilder();
      builder.pushStandaloneToolEntry({ kind: "tool", id: "call", name: toolName, presentation: { name: "Neutral", detail: "" }, timestamp: Date.now(), status: "pending" });
      resolveTrackedToolResult(builder, { kind: "standalone", toolName, streamsInput: false }, "call", outcome, textContent("result"), details);
      return toolBlock(builder);
    };
    const read = { name: "Read", detail: "list tool contract" };
    expect(settle("list", "ok", { contractRead: true })).toMatchObject({ presentation: read, sentence: read, action: "search" });
    // A bookkeeping tool's contract read is a lookup too, so it groups under Explored, not Ran.
    expect(settle("memory", "ok", { contractRead: true })).toMatchObject({ presentation: { name: "Read", detail: "memory tool contract" }, action: "search" });
    // A full-form call with no arguments, and a refused or invalid call, keep their own presentation.
    expect(settle("search", "error").presentation).toEqual({ name: "Neutral", detail: "" });
    expect(settle("list", "ok").presentation).toEqual({ name: "Neutral", detail: "" });
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
