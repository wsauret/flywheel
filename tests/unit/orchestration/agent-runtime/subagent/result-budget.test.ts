import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentResultSummary } from "../../../../../src/infra/output/structured-event-tool-results.js";
import {
  boundHandoff,
  MAX_RESULT_CHARS,
  resultCharBudget,
  type ResultBudget,
} from "../../../../../src/orchestration/modules/subagents/execution/result-budget.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("resultCharBudget", () => {
  it("falls back to the static ceiling when the parent has no admission budget", () => {
    expect(resultCharBudget(undefined, 3)).toBe(MAX_RESULT_CHARS);
  });

  it("gives only the floor when the parent's admission budget is spent", () => {
    expect(resultCharBudget(0, 1)).toBe(2_000);
  });

  it("divides the remaining slice across the batch", () => {
    // Half of 400k remaining chars is the batch slice.
    expect(resultCharBudget(400_000, 10)).toBe(20_000);
    // A larger batch shrinks each slice below the ceiling.
    expect(resultCharBudget(400_000, 20)).toBe(10_000);
    // A small batch is still capped by the static ceiling.
    expect(resultCharBudget(400_000, 1)).toBe(MAX_RESULT_CHARS);
  });

  it("never drops below the floor even for huge batches", () => {
    expect(resultCharBudget(40_000, 100)).toBe(2_000);
  });
});

describe("boundHandoff", () => {
  const usage = 400_000;

  function budget(dir: string, cap: number, overrides: Partial<ResultBudget> = {}): ResultBudget {
    return { cap, executionCwd: dir, projectRoot: dir, artifactScopeId: "session-1", agentType: "explorer", ...overrides };
  }

  it("returns an under-budget handoff as its exact pretty JSON", async () => {
    const handoff = { summary: "short and sweet", files_modified: ["a.ts"] };
    const text = await boundHandoff(handoff, budget(temporaryDirectory("flywheel-result-budget-"), resultCharBudget(usage, 1)));
    expect(text).toBe(JSON.stringify(handoff, null, 2));
  });

  it("cuts every field over its share of the cap and keeps valid JSON with the card's summary sentence", async () => {
    const dir = temporaryDirectory("flywheel-result-budget-");
    const projectRoot = join(dir, "project");
    const executionCwd = join(projectRoot, "package");
    mkdirSync(executionCwd, { recursive: true });
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i}: "finding" detail\twith padding`);
    const handoff = {
      summary: `Found the leak in the parser.\n\n${lines.join("\n")}`,
      files_modified: ["src/parser.ts", "tests/parser.test.ts"],
      raw_dump: "y".repeat(200_000),
    };
    const cap = resultCharBudget(usage, 1);

    const text = await boundHandoff(handoff, budget(executionCwd, cap, { projectRoot }));

    expect(text.length).toBeLessThanOrEqual(cap);
    const bounded = JSON.parse(text);
    expect(Object.keys(bounded)).toEqual(["summary", "files_modified", "raw_dump", "truncated"]);
    expect(agentResultSummary(text)).toBe("Found the leak in the parser");
    expect(bounded.files_modified).toEqual(handoff.files_modified);
    expect(bounded.summary).toContain("line 3999:");
    expect(bounded.truncated.fields).toEqual(["summary", "raw_dump"]);
    const savedPath = bounded.truncated.full_handoff_path;
    expect(savedPath).toStartWith("../.flywheel/agent-outputs/session-1/subagent-handoff-explorer");
    expect(readFileSync(join(executionCwd, savedPath), "utf8")).toBe(JSON.stringify(handoff, null, 2));
  });

  it.each([
    ["30 fields at the floor", 2_000, 30, true],
    ["100 fields at the floor", 2_000, 100, false],
    ["400 fields at the ceiling", MAX_RESULT_CHARS, 400, true],
  ])("keeps the summary's head and tail within the cap when %s cannot each keep a note", async (_case, cap, count, named) => {
    const dir = temporaryDirectory("flywheel-result-budget-");
    const fields = Array.from({ length: count }, (_, i) => [`finding_${i}`, "z".repeat(1_000)]);
    const handoff = { summary: `Found the leak in the parser. ${"s".repeat(30_000)}`, ...Object.fromEntries(fields) };

    const text = await boundHandoff(handoff, budget(dir, cap));

    expect(text.length).toBeLessThanOrEqual(cap);
    expect(agentResultSummary(text)).toBe("Found the leak in the parser");
    const bounded = JSON.parse(text);
    expect(Object.keys(bounded)).toEqual(["summary", "truncated"]);
    expect(bounded.truncated.full_handoff_path).toStartWith(".flywheel/agent-outputs/session-1/subagent-handoff-explorer");
    // The names when they fit half the cap, else their count.
    expect(bounded.truncated).toMatchObject(named ? { fields: Object.keys(handoff) } : { field_count: count + 1 });
  });

  it("gives the share of a value cut to a note back to the summary", async () => {
    const dir = temporaryDirectory("flywheel-result-budget-");
    const handoff = { summary: "S".repeat(30_000), findings: Array.from({ length: 3_000 }, (_, i) => ({ site: `a.ts:${i}` })) };

    const bounded = JSON.parse(await boundHandoff(handoff, budget(dir, MAX_RESULT_CHARS)));

    expect(bounded.findings).toStartWith("[omitted:");
    expect(bounded.summary.length).toBeGreaterThan(MAX_RESULT_CHARS - 500);
    expect(bounded.truncated.fields).toEqual(["summary", "findings"]);
  });

  it("names a child field called truncated as cut, so the marker cannot hide it", async () => {
    const dir = temporaryDirectory("flywheel-result-budget-");
    const bounded = JSON.parse(await boundHandoff({ summary: "q".repeat(30_000), truncated: "child value" }, budget(dir, MAX_RESULT_CHARS)));
    expect(bounded.truncated.fields).toEqual(["truncated", "summary"]);
  });

  it("divides the cap by batch size so a fan-out cannot blow the parent window", async () => {
    const dir = temporaryDirectory("flywheel-result-budget-");
    // 12k chars fits the solo budget (24k ceiling) but not a 20-way batch
    // slice of the same headroom (10k chars each).
    const handoff = { summary: "x".repeat(12_000) };
    const solo = JSON.parse(await boundHandoff(handoff, budget(dir, resultCharBudget(usage, 1))));
    expect(solo.truncated).toBeUndefined();

    const inBatch = JSON.parse(await boundHandoff(handoff, budget(dir, resultCharBudget(usage, 20))));
    expect(inBatch.truncated.fields).toEqual(["summary"]);
  });
});
