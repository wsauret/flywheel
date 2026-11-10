import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enforceTurnBudget,
  type TurnBudgetEntry,
} from "../../../../../src/orchestration/agent-runtime/compaction/truncation.js";
import {
  CHARS_PER_TOKEN,
  createContextAdmission,
  proactiveCompactionTriggers,
  SAVE_ROUND_RESERVE_TOKENS,
  turnBudgetChars,
} from "../../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js";

import { messageInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js";

function entry(id: string, chars: number, overrides: Partial<TurnBudgetEntry> = {}): TurnBudgetEntry {
  return {
    toolUseId: id,
    toolName: "bash",
    exempt: false,
    content: [{ type: "text", text: `${id}-head\n${"x".repeat(Math.max(0, chars - id.length - 6))}` }],
    ...overrides,
  };
}

describe("turnBudgetChars", () => {
  test("large windows keep the default budget; small windows scale down with a floor", () => {
    expect(turnBudgetChars(undefined)).toBe(200_000);
    expect(turnBudgetChars(200_000)).toBe(200_000);
    // 100k tokens * 4 chars * 0.3 = 120k chars.
    expect(turnBudgetChars(100_000)).toBe(120_000);
    // Tiny window: floored.
    expect(turnBudgetChars(4_000)).toBe(16_000);
  });
});

describe("context admission budget", () => {
  /** The last estimate that does not yet trigger proactive compaction. */
  function lastTokenBelowTrigger(contextLimit: number): number {
    return proactiveCompactionTriggers(contextLimit, 270_000)[0]! - 1;
  }

  test.each([128_000, 200_000])("a batch admitted below the trigger leaves the save reserve inside a %i-token window", (contextLimit) => {
    const promptTokens = lastTokenBelowTrigger(contextLimit);
    const bound = createContextAdmission(() => ({ promptTokens, contextLimit })).openRequest();

    expect(bound.readsExempt).toBe(false);
    expect(promptTokens + bound.chars / CHARS_PER_TOKEN + SAVE_ROUND_RESERVE_TOKENS).toBeLessThanOrEqual(contextLimit);
  });

  test("reads keep their exemption while the fixed share binds", () => {
    const bound = createContextAdmission(() => ({ promptTokens: 10_000, contextLimit: 200_000 })).openRequest();
    expect(bound).toMatchObject({ chars: turnBudgetChars(200_000), readsExempt: true });
  });

  test("tool batches and held subagent results draw from one budget until the history takes them", () => {
    let promptTokens = 150_000;
    const admission = createContextAdmission(() => ({ promptTokens, contextLimit: 200_000 }));
    const headroom = (200_000 - SAVE_ROUND_RESERVE_TOKENS - promptTokens) * CHARS_PER_TOKEN;
    const bound = admission.openRequest();
    expect(bound.chars).toBe(headroom);
    // While the batch runs, its whole bound is reserved.
    expect(admission.remainingChars()).toBe(0);
    bound.admit(30_000);
    expect(admission.remainingChars()).toBe(headroom - 30_000);
    admission.reserve("run-a", 10_000);
    expect(admission.remainingChars()).toBe(headroom - 40_000);

    // The next request measures the batch, but the held result is not in its history yet.
    promptTokens += 30_000 / CHARS_PER_TOKEN;
    const next = admission.openRequest();
    expect(next.chars).toBe(headroom - 40_000);
    next.admit(0);
    expect(admission.remainingChars()).toBe(headroom - 40_000);

    // Its notification enters the history at its rendered size and releases the hold.
    admission.admit(12_000, ["run-a"]);
    expect(admission.remainingChars()).toBe(headroom - 42_000);
  });

  test("the loop releases a held result when its notification enters the history, after a request opened in between", async () => {
    const remaining: number[] = [];
    const tool = (name: string, hold: boolean): RuntimeTool => ({
      name, description: name, action: "ui_meta", isConcurrencySafe: true, inputSchema: { type: "object", properties: {} },
      execute: async (_input, context) => {
        if (hold) context.contextAdmission?.reserve("run-a", 50_000);
        remaining.push(context.contextAdmission?.remainingChars() ?? -1);
        return { content: "ok", outcome: "ok", terminate: false };
      },
    });
    const toolRound = (id: string, name: string) => ({ events: [{ kind: "tool_use" as const, toolCall: { id, name, input: {} } }, { kind: "done" as const, stopReason: "tool_use" as const }] });
    const answer = (value: string) => ({ events: [{ kind: "text_delta" as const, text: value, blockKey: value }, { kind: "done" as const, stopReason: "end_turn" as const }] });
    const { client } = makeCaptureClient([toolRound("dispatch", "dispatch"), answer("Waiting."), toolRound("probe", "probe"), answer("Done.")], { contextLimit: 400_000 });
    const notes = withSessionNotes(new RequestToolMap([["dispatch", tool("dispatch", true)], ["probe", tool("probe", false)]]));
    const inputs = [messageInput("<subagent_notifications>result</subagent_notifications>", { origin: "silent-system", backgroundNotificationIds: ["subagent-completions:run-a"] })];
    const result = await runAgentLoop({
      client, ...notes, systemPrompt: stableSystemPrompt("test"), instruction: "do it",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "admission", promptCacheKey: "admission", artifactScopeId: "admission", retrievalSessionId: "admission",
      persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, onEvent: () => {},
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => inputs.shift() ?? null, cancel: async () => {} }) },
    });

    expect(result.kind).toBe("input_closed");
    expect(remaining).toHaveLength(2);
    // The hold outlasted the request that opened while the result waited, and the delivery released it.
    expect(remaining[1]! - remaining[0]!).toBeGreaterThan(40_000);
  });
});

describe("enforceTurnBudget", () => {
  test("an under-budget batch is untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-turn-budget-"));
    try {
      const replacements = await enforceTurnBudget(
        [entry("a", 30_000), entry("b", 30_000)],
        { budgetChars: turnBudgetChars(100_000), executionCwd: dir, projectRoot: dir, artifactScopeId: "session-under" },
      );
      expect(replacements).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replaces the largest results with preview-pointers until the batch fits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-turn-budget-"));
    try {
      // Budget for a 100k window is 120k chars; three 50k results plus tail
      // need the two largest persisted to fit.
      const entries = [
        entry("big-1", 50_000),
        entry("big-2", 50_000),
        entry("big-3", 50_000),
        entry("small-1", 10_000),
        entry("small-2", 5_000),
        entry("small-3", 5_000),
      ];
      const replacements = await enforceTurnBudget(entries, {
        budgetChars: turnBudgetChars(100_000), executionCwd: dir, projectRoot: dir, artifactScopeId: "session-1", capabilities: () => true,
      });
      expect(replacements).toHaveLength(2);
      expect(replacements.map((r) => r.toolUseId).sort()).toEqual(["big-1", "big-2"]);
      for (const replacement of replacements) {
        const text = replacement.content[0];
        if (text?.type !== "text") throw new Error("expected text part");
        expect(text.text).toContain("<persisted-output>");
        expect(text.text).toContain("Full output saved to:");
        expect(text.text).toContain("Preview");
        expect(text.text).toContain("Read that file with offset/limit, or grep it with the search tool, to access specific sections.");
        // The full text is recoverable at the named path.
        const match = text.text.match(/Full output saved to: (.+)/);
        if (!match?.[1]) throw new Error("expected a saved path");
        expect(readFileSync(join(dir, match[1]), "utf8")).toContain(`${replacement.toolUseId}-head`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("names only the retrieval tools that the reading agent holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-turn-budget-"));
    try {
      const entries = [entry("big-1", 150_000)];
      const textOf = async (held: readonly string[] | undefined): Promise<string> => {
        const [replacement] = await enforceTurnBudget(entries, {
          budgetChars: turnBudgetChars(100_000), executionCwd: dir, projectRoot: dir, artifactScopeId: `session-${held?.join("-") ?? "unknown"}`,
          ...(held ? { capabilities: (term: string) => held.includes(term) } : {}),
        });
        const part = replacement?.content[0];
        if (part?.type !== "text") throw new Error("expected text part");
        return part.text;
      };
      const readOnly = await textOf(["read"]);
      expect(readOnly).toContain("Read that file with offset/limit, to access specific sections.");
      expect(readOnly).not.toContain("search tool");
      const shellOnly = await textOf(["bash"]);
      expect(shellOnly).toContain("Inspect it with a shell command, to access specific sections.");
      const none = await textOf([]);
      expect(none).toContain("The rest of the output is not available with your tools.");
      expect(none).not.toMatch(/search tool|offset\/limit/);
      // Recovery does not know the reader's tools: the block names the file and no tool.
      const unknown = await textOf(undefined);
      expect(unknown).toContain("Full output saved to:");
      expect(unknown).not.toMatch(/search tool|offset\/limit|shell command|not available/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an uncapped result is never persisted, and a read is persisted once headroom binds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-turn-budget-"));
    try {
      const entries = [
        entry("skill-1", 60_000, { toolName: "skill", exempt: true }),
        entry("read-1", 40_000, { toolName: "read" }),
      ];
      const replacements = await enforceTurnBudget(entries, {
        budgetChars: 70_000, executionCwd: dir, projectRoot: dir, artifactScopeId: "session-headroom",
      });
      expect(replacements.map((r) => r.toolUseId)).toEqual(["read-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exempt results are never persisted even when they are the largest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-turn-budget-"));
    try {
      const entries = [
        entry("read-1", 100_000, { toolName: "read", exempt: true }),
        entry("bash-1", 40_000),
        entry("bash-2", 10_000),
      ];
      const replacements = await enforceTurnBudget(entries, {
        budgetChars: turnBudgetChars(100_000), executionCwd: dir, projectRoot: dir, artifactScopeId: "session-exempt",
      });
      expect(replacements.map((r) => r.toolUseId)).toEqual(["bash-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("already-persisted results are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-turn-budget-"));
    try {
      const fresh = entry("p-1", 100_000);
      const freshText = fresh.content[0];
      if (freshText?.type !== "text") throw new Error("expected text part");
      const persisted: TurnBudgetEntry = { ...fresh, content: [{ type: "text", text: `<persisted-output>\n${freshText.text}` }] };
      const entries = [persisted, entry("bash-1", 40_000)];
      const replacements = await enforceTurnBudget(entries, {
        budgetChars: turnBudgetChars(100_000), executionCwd: dir, projectRoot: dir, artifactScopeId: "session-persisted",
      });
      expect(replacements.map((r) => r.toolUseId)).toEqual(["bash-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
