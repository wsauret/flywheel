import { describe, expect, it } from "bun:test";

import { createExecutionNotesHook } from "../../../../../src/orchestration/agent-runtime/execution-notes.js";
import type { ToolCall } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { NO_CAPABILITY_ACCESS, type ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeContext } from "../tools/_fixtures.js";

let nextId = 0;

function bashCall(command: string): ToolCall {
  return { id: `tc-${nextId++}`, name: "bash", input: { command } };
}

function bashResult(content: string, details: { exitCode?: number; durationMs?: number }): ToolResult {
  return { content, outcome: "ok", details };
}

const ctx = makeContext();

describe("execution notes hook", () => {
  it("resets the repeat counter on success", () => {
    const hook = createExecutionNotesHook();
    const failure = () => bashResult("Error: flaky\n[exit code: 1]", { exitCode: 1 });
    hook(bashCall("a"), failure(), ctx);
    hook(bashCall("ok"), bashResult("fine\n[exit code: 0]", { exitCode: 0 }), ctx);
    const third = hook(bashCall("a"), failure(), ctx);
    expect(third.content).not.toContain("Execution note:");
  });

  it("treats identical unrecognized failure output as the same error", () => {
    const hook = createExecutionNotesHook();
    const failure = () => bashResult("(no output)\n[exit code: 7]", { exitCode: 7, durationMs: 5 });
    hook(bashCall("a"), failure(), ctx);
    const second = hook(bashCall("b"), failure(), ctx);
    expect(second.content).toContain("Execution note: the same error has now occurred twice");
    expect(second.outcome).toBe("ok");
    expect(second.details).toEqual({ exitCode: 7, durationMs: 5 });
  });

  it("does not fire when failures share an exit code but the output differs", () => {
    const hook = createExecutionNotesHook();
    hook(bashCall("lint"), bashResult("src/a.ts(10,5): error TS2304: Cannot find name 'x'.\n[exit code: 2]", { exitCode: 2 }), ctx);
    const second = hook(bashCall("lint"), bashResult("src/b.ts(3,1): error TS2552: Cannot find name 'y'.\n[exit code: 2]", { exitCode: 2 }), ctx);
    expect(second.content).not.toContain("Execution note:");
  });

  it("re-arms the repeated-error note after a success ends the streak", () => {
    const hook = createExecutionNotesHook();
    const firstStreak = () => bashResult("Error: ENOENT\n[exit code: 1]", { exitCode: 1 });
    hook(bashCall("a"), firstStreak(), ctx);
    expect(hook(bashCall("b"), firstStreak(), ctx).content).toContain("Execution note:");

    hook(bashCall("ok"), bashResult("fine\n[exit code: 0]", { exitCode: 0 }), ctx);

    const secondStreak = () => bashResult("Error: EACCES\n[exit code: 1]", { exitCode: 1 });
    hook(bashCall("c"), secondStreak(), ctx);
    const fired = hook(bashCall("d"), secondStreak(), ctx);
    expect(fired.content).toContain("Execution note: the same error has now occurred twice");
  });

  it("fires the repeated-error note at most once per run", () => {
    const hook = createExecutionNotesHook();
    const failure = () => bashResult("Error: stuck\n[exit code: 1]", { exitCode: 1 });
    hook(bashCall("a"), failure(), ctx);
    hook(bashCall("b"), failure(), ctx);
    const third = hook(bashCall("c"), failure(), ctx);
    expect(third.content).not.toContain("Execution note:");
  });

  it("notes a long-running command once", () => {
    const hook = createExecutionNotesHook();
    const slow = () => bashResult("done\n[exit code: 0 in 2m 0s]", { exitCode: 0, durationMs: 120_000 });

    const first = hook(bashCall("slow"), slow(), ctx);
    expect(first.content).toContain("Execution note: this command consumed 2m 0s");
    expect(first.content).toContain("moves to managed execution when you select Detach or it reaches the runtime cap; wait for it with the process tool.");

    const second = hook(bashCall("slow again"), slow(), ctx);
    expect(second.content).not.toContain("Execution note:");
  });

  // No person reads an unattended chat (PI-AGENT-121), so its note names no Detach.
  it("states the runtime cap without Detach in an unattended chat", () => {
    const unattended = makeContext({ capabilityAccess: { ...NO_CAPABILITY_ACCESS, unattended: true } });
    const note = createExecutionNotesHook()(bashCall("slow"), bashResult("done", { exitCode: 0, durationMs: 120_000 }), unattended).content;
    expect(note).toContain("moves to managed execution when it reaches the runtime cap; wait for it with the process tool.");
    expect(note).not.toContain("Detach");
  });

  it("notes a command at the 90 second threshold", () => {
    const hook = createExecutionNotesHook();
    const result = hook(bashCall("slow"), bashResult("done", { exitCode: 0, durationMs: 90_000 }), ctx);
    expect(result.content).toContain("Execution note: this command consumed 1m 30s");
  });

  it("prefers the repeated-error note when both patterns fire, leaving long-step armed", () => {
    const hook = createExecutionNotesHook();
    const slowFailure = () => bashResult("Error: timeout-ish\n[exit code: 1]", { exitCode: 1, durationMs: 120_000 });
    hook(bashCall("a"), bashResult("Error: timeout-ish\n[exit code: 1]", { exitCode: 1, durationMs: 10 }), ctx);
    const second = hook(bashCall("b"), slowFailure(), ctx);
    expect(second.content).toContain("the same error has now occurred twice");
    expect(second.content).not.toContain("this command consumed");

    const later = hook(bashCall("slow build"), bashResult("done\n[exit code: 0]", { exitCode: 0, durationMs: 95_000 }), ctx);
    expect(later.content).toContain("Execution note: this command consumed");
  });

  it("notes every registration of the shell and no other tool", () => {
    // As the exposure planner maps them: each registration to the tool it serves.
    const planned = makeContext({ toolNames: { logical: (name) => ({ exec: "bash", apply_patch: "edit" })[name] ?? name, presented: (name) => name } });
    for (const [name, noted] of [["bash", true], ["exec", true], ["edit", false], ["apply_patch", false]] as const) {
      const hook = createExecutionNotesHook();
      const failure = () => bashResult("Error: stuck\n[exit code: 1]", { exitCode: 1 });
      hook({ id: `${name}-1`, name, input: { command: "a" } }, failure(), planned);
      const second = hook({ id: `${name}-2`, name, input: { command: "b" } }, failure(), planned);
      expect(String(second.content).includes("Execution note:")).toBe(noted);
    }
  });

  it("ignores results without exit codes", () => {
    const hook = createExecutionNotesHook();
    const background = bashResult("Started in background. PID: 1.", {});
    expect(hook(bashCall("sleep 100 &"), background, ctx)).toBe(background);
  });

  it("rejects malformed internal bash result details", () => {
    const hook = createExecutionNotesHook();
    const malformed: ToolResult = { content: "bad", outcome: "error", details: { exitCode: "1" } };
    expect(() => hook(bashCall("bad"), malformed, ctx)).toThrow();
  });
});
