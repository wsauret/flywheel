import { describe, expect, it } from "bun:test";

import {
  failedRunResult,
  resolveSubagentResult,
  type SubagentResultContext,
} from "../../../../../src/orchestration/modules/subagents/execution/result-resolver.js";
import { createSubagentStats } from "../../../../../src/orchestration/modules/subagents/execution/stream-filter.js";
import type { AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import type { SubagentToolCallRecord } from "../../../../../src/orchestration/modules/subagents/execution/work-log.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();
const CAP = 2_000;

function baseCtx(overrides: Partial<SubagentResultContext> = {}): SubagentResultContext {
  return {
    agentType: "general-purpose",
    childRunId: "run1",
    childSessionId: "child-session-1",
    toolUseId: undefined,
    descriptionText: "do a thing",
    maxTurns: 10,
    getCapturedHandoff: () => null,
    textState: { finalAssistantText: "" },
    modelRequestId: undefined,
    parentToolUseId: undefined,
    stats: createSubagentStats(),
    deps: { onRenderEvent: () => {} },
    turnLog: [],
    budget: { cap: CAP, executionCwd: "/scratch/project", projectRoot: "/scratch/project", artifactScopeId: "session-1", agentType: "general-purpose" },
    signal: undefined,
    ...overrides,
  };
}

describe("resolveSubagentResult — status derives from the typed result, not prose", () => {
  it("marks a structurally-successful run completed even when its text mentions error codes", async () => {
    // Regression: the old heuristic regex-scanned the assistant prose and
    // false-flagged legitimate text like "404" as an API error -> failed.
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "completed" } };
    const out = await resolveSubagentResult(
      result,
      baseCtx({ textState: { finalAssistantText: "Fixed the 404 handler and added a rate_limit test." } }),
    );
    expect(out.status).toBe("completed");
    expect(out.content).toContain("Fixed the 404 handler");
  });

  it("returns a captured handoff as the same pretty JSON the parent previously read from disk", async () => {
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "completed" } };
    const out = await resolveSubagentResult(
      result,
      baseCtx({ getCapturedHandoff: () => ({ summary: "done", files_modified: ["src/app.ts"] }) }),
    );
    expect(out.status).toBe("completed");
    expect(out.content).toBe(JSON.stringify({ summary: "done", files_modified: ["src/app.ts"] }, null, 2));
  });

  it("reports a budget-capped run with a handoff as partial, not completed", async () => {
    // Five children hitting maxTurns must not read as five completions: the
    // status is the parent's only runtime signal that the work stopped early.
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "budget_exhausted" } };
    const out = await resolveSubagentResult(
      result,
      baseCtx({ getCapturedHandoff: () => ({ summary: "half done; the second file is not done" }) }),
    );
    expect(out.status).toBe("partial");
    expect(out.content).toBe(JSON.stringify({ summary: "half done; the second file is not done" }, null, 2));
  });

  it("returns a handoff in the shape before blocker retirement unchanged, blockers included", async () => {
    // The subagent handoff schema no longer names `blockers`, but it admits
    // extra keys, and the parent reads the result as text. A child on an
    // earlier prompt that still sends `blockers` loses nothing.
    const legacy = { summary: "stopped", files_modified: [], blockers: ["the credential is missing"] };
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "completed" } };
    const out = await resolveSubagentResult(result, baseCtx({ getCapturedHandoff: () => legacy }));
    expect(out.status).toBe("completed");
    expect(out.content).toContain("the credential is missing");
  });

  it("reports a budget-capped run with text as partial and leaves the text unprefixed", async () => {
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "budget_exhausted" } };
    const out = await resolveSubagentResult(result, baseCtx({ textState: { finalAssistantText: "Got as far as the parser." } }));
    expect(out.status).toBe("partial");
    expect(out.content).toBe("Got as far as the parser.");
  });

  it("reports a budget-capped run without a handoff or text as partial and names the turn budget", async () => {
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "budget_exhausted" } };
    const out = await resolveSubagentResult(result, baseCtx());
    expect(out.status).toBe("partial");
    expect(out.content).toBe("Subagent 'general-purpose' (do a thing) reached its turn budget (10 LLM calls) before it wrote a result.");
  });

  it("cuts a text result over the cap and names the file that keeps it whole", async () => {
    const dir = temporaryDirectory("flywheel-result-resolver-");
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "completed" } };
    const text = `Opening conclusion.\n${"detail ".repeat(2_000)}\nClosing outcome.`;
    const out = await resolveSubagentResult(result, baseCtx({
      textState: { finalAssistantText: text },
      budget: { cap: CAP, executionCwd: dir, projectRoot: dir, artifactScopeId: "session-1", agentType: "general-purpose" },
    }));
    expect(out.status).toBe("completed");
    expect(out.content.length).toBeLessThanOrEqual(CAP);
    expect(out.content).toStartWith("Opening conclusion.");
    expect(out.content).toContain("Closing outcome.");
    expect(out.content).toMatch(/\[Full output saved to \.flywheel\/agent-outputs\/session-1\/subagent-general-purpose_[^;]+; grep it with the search tool if you need the removed content\]$/);
  });

  it("bounds a failed run's work summary within the cap", async () => {
    const dir = temporaryDirectory("flywheel-result-resolver-");
    const turnLog: SubagentToolCallRecord[] = [{ toolName: "read", input: {}, status: "done" }];
    const out = await failedRunResult(new Error("owner closed"), "run", baseCtx({
      turnLog,
      deps: { onRenderEvent: () => {}, summarizeOnFailure: async () => "- read a file\n".repeat(1_000) },
      budget: { cap: CAP, executionCwd: dir, projectRoot: dir, artifactScopeId: "session-1", agentType: "general-purpose" },
    }));
    expect(out.status).toBe("failed");
    expect(out.content).toStartWith("Subagent 'general-purpose' (do a thing) failed mid-run: owner closed.");
    expect(out.content.length).toBeLessThanOrEqual(CAP);
  });

  it("marks a run failed when the typed result carries a failure", async () => {
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "api_error", message: "boom", recovery: { kind: "none" } } };
    const out = await resolveSubagentResult(result, baseCtx({ textState: { finalAssistantText: "irrelevant" } }));
    expect(out.status).toBe("failed");
  });

  it("returns failure details without retry advice or publishing a parent tool result", async () => {
    const cases = [
      { kind: "api_overloaded", message: "persistent overload" },
      { kind: "transient_disconnect", message: "socket reset" },
      { kind: "stream_stalled", message: "no progress", attribution: { kind: "unattributed" } },
      { kind: "api_error", message: "request failed", recovery: { kind: "none" } },
    ] satisfies ReadonlyArray<AgentRunResult["terminal"]>;

    for (const terminal of cases) {
      const events: RuntimeEvent[] = [];
      const result = await resolveSubagentResult(
        { servedRequests: 0, durationMs: 5, terminal },
        baseCtx({
          toolUseId: `tool-${terminal.kind}`,
          model: "review-model",
          deps: { onRenderEvent: (event) => { events.push(event); } },
        }),
      );
      expect(result.status).toBe("failed");
      expect(result.content).toContain(terminal.message);
      expect(result.content).not.toMatch(/\bretry\b|re-dispatch|dispatch one|different provider/);
      expect(events).toEqual([]);
    }
  });

  it("leaves deferred terminal publication to child-session reconciliation", async () => {
    const events: RuntimeEvent[] = [];
    const result: AgentRunResult = { servedRequests: 0, durationMs: 5, terminal: { kind: "completed" } };
    await resolveSubagentResult(result, baseCtx({
      toolUseId: "tool-child",
      parentToolUseId: "tool-parent",
      modelRequestId: "req-1",
      textState: { finalAssistantText: "done" },
      deps: { onRenderEvent: (event) => { events.push(event); } },
    }));
    expect(events).toEqual([]);
  });

  it("resolves a person's Stop as stopped, naming who stopped it, without an agent failure", async () => {
    const events: RuntimeEvent[] = [];
    const out = await resolveSubagentResult(
      { servedRequests: 0, durationMs: 5, terminal: { kind: "aborted" } },
      baseCtx({
        cancellationSource: "user",
        toolUseId: "tool-stopped",
        deps: { onRenderEvent: (event) => events.push(event) },
      }),
    );

    expect(out).toMatchObject({ status: "stopped", content: expect.stringContaining("was stopped by the user. Do not redo the stopped work. Tell the user it stopped and wait for their direction.") });
    expect(out).not.toHaveProperty("modelFailure");
    expect(events).toEqual([]);
  });

  it("resolves an agent-requested abort as cancellation without an agent failure", async () => {
    const events: RuntimeEvent[] = [];
    const out = await resolveSubagentResult(
      { servedRequests: 0, durationMs: 5, terminal: { kind: "aborted" } },
      baseCtx({
        cancellationSource: "agent",
        toolUseId: "tool-cancelled",
        deps: { onRenderEvent: (event) => events.push(event) },
      }),
    );

    expect(out).toMatchObject({ status: "cancelled", content: expect.stringContaining("was canceled") });
    expect(events).toEqual([]);
  });
});
