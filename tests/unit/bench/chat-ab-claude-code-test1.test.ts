import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { namesShippedSite, SHIPPED_SITES, test1Input, TEST1_WORKFLOW } from "../../../bench/chat-ab/workflow-audit-tests.js";
import { ToolActionSchema } from "../../../src/infra/workflow-types.js";
import { describeDefinitionRefusal, loadPathWorkflow, sessionWorkflowsDir } from "../../../src/orchestration/workflow-host/path-workflow.js";
import { latestReducer } from "../../../src/workflows/reducers/registry.js";
import { compileOutput } from "../../../src/workflows/output-contract/compile.js";
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";

const temporary = temporaryDirectories();
const revision = repoDefinitions().captureRevision();
const CHAT_AUTHORITY = { toolActions: new Set(ToolActionSchema.literals.filter((action) => action !== "task_subagent")), personas: new Set<string>() };

interface AgentCall {
  readonly prompt: string;
  readonly options: { readonly label?: string; readonly phase?: string; readonly schema?: unknown; readonly [key: string]: unknown };
}

interface Finding {
  readonly site: string;
  readonly path: string;
  readonly line: number;
  readonly claim: string;
}

/** What a stub agent answers: a review's findings, a verification's verdict, or the report's text. */
type AgentAnswer = { readonly findings: readonly Finding[] } | { readonly site: string | undefined; readonly verdict: string; readonly evidence: string } | string;

/** Runs the Claude Code script with the engine's globals, as the engine's vm does: the module syntax stripped and the
 *  body inside an async function. `answer` stands in for each agent. The script returns the report's text. */
async function runScript(source: string, launchArgs: ReturnType<typeof test1Input> | string, answer: (call: AgentCall) => AgentAnswer): Promise<{ readonly calls: AgentCall[]; readonly result: string }> {
  const calls: AgentCall[] = [];
  const context = {
    args: launchArgs,
    agent: async (prompt: string, options: AgentCall["options"] = {}) => {
      const call = { prompt, options };
      calls.push(call);
      return answer(call);
    },
    // The engine settles every thunk and gives a thrown agent null.
    parallel: async (thunks: readonly (() => Promise<AgentAnswer>)[]) => (await Promise.allSettled(thunks.map((thunk) => thunk()))).map((settled) => settled.status === "fulfilled" ? settled.value : null),
    phase: () => undefined,
    log: () => undefined,
  };
  const body = source.replace(/^export const meta/mu, "const meta");
  const result: unknown = await runInNewContext(`(async () => {\n${body}\n})()`, context);
  if (typeof result !== "string") throw new Error(`The script returned ${typeof result}, not the report's text`);
  return { calls, result };
}

/** The Flywheel file, read through the path launch pipeline that the chat agent's launch runs. */
async function launchedFlywheelFile() {
  const sessionDir = realpathSync(temporary("chat-ab-claude-code-test1-"));
  mkdirSync(sessionWorkflowsDir(sessionDir), { recursive: true });
  writeFileSync(join(sessionWorkflowsDir(sessionDir), "review.workflow.yaml"), readFileSync(TEST1_WORKFLOW.flywheel, "utf8"));
  const launched = await loadPathWorkflow({ path: "scratch/workflows/review.workflow.yaml", sessionDir, revision, authority: CHAT_AUTHORITY });
  if (!launched.ok) throw new Error(`The test 1 file was refused: ${Object.values(describeDefinitionRefusal("", launched)).flat().join("\n")}`);
  return launched;
}

/** The declared fields of a Flywheel step's output, as the tool input schema that the step's agent receives, without
 *  the handoff envelope (`summary`, `commands_run`, `files_modified`) that every Flywheel step adds. */
interface DeclaredSchema {
  readonly type: "object";
  readonly properties: { readonly [key: string]: unknown };
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredSchema(output: Parameters<typeof compileOutput>[0]): DeclaredSchema {
  const { properties, required } = compileOutput(output).toolInput;
  if (!isRecord(properties) || !Array.isArray(required)) throw new Error("The compiled output is not an object schema");
  const envelope = new Set(["summary", "commands_run", "files_modified"]);
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !envelope.has(key))),
    required: required.filter((key): key is string => typeof key === "string" && !envelope.has(key)),
    additionalProperties: false,
  };
}

describe("chat A/B comparison with Claude Code, test 1", () => {
  it("writes one topology twice: the Claude Code script gives each agent the Flywheel step's instructions byte for byte, its declared schema, and the same dedupe, and neither file pins a model or an effort", async () => {
    const launched = await launchedFlywheelFile();
    const steps = resolveWorkflowAgents(launched.workflow);
    const step = (id: string) => {
      const resolved = steps.get(id);
      if (!resolved) throw new Error(`The test 1 file has no step ${id}`);
      return resolved;
    };
    const instructions = (id: string) => step(id).body.trim();
    const authoredOutput = (id: string) => {
      const phase = launched.workflow.phases.find((entry) => "phase" in entry && entry.phase === id);
      const output = phase && "output" in phase ? phase.output : undefined;
      // A phase's output is a contract file name or a declared output; each test 1 phase declares its fields.
      if (!output || typeof output === "string") throw new Error(`The test 1 phase ${id} declares no fields`);
      return output;
    };

    // Two reviews report the same site; the review of anthropic.ts reports a bug in json-parse.ts that the review of
    // json-parse.ts reports too. The path order puts anthropic.ts first, so its copy is kept.
    const findings = new Map<string, readonly Finding[]>([
      ["src/orchestration/agent-runtime/llm/json-parse.ts", [
        { site: "src/orchestration/agent-runtime/llm/json-parse.ts:162", path: "src/orchestration/agent-runtime/llm/json-parse.ts", line: 162, claim: "partial parse completes a cut prefix" },
        { site: "src/orchestration/agent-runtime/llm/json-parse.ts:9", path: "src/orchestration/agent-runtime/llm/json-parse.ts", line: 9, claim: "a second bug" },
      ]],
      ["src/orchestration/agent-runtime/llm/anthropic.ts", [
        { site: "src/orchestration/agent-runtime/llm/json-parse.ts:162", path: "src/orchestration/agent-runtime/llm/json-parse.ts", line: 162, claim: "the same bug, worded differently" },
      ]],
    ]);
    const source = readFileSync(TEST1_WORKFLOW.claudeCode, "utf8");
    // The model may pass the launch input as JSON text, and the script reads it either way.
    for (const launchArgs of [test1Input(), JSON.stringify(test1Input())]) {
      const { calls, result } = await runScript(source, launchArgs, (call) => {
        if (call.options.phase === "Review") return { findings: findings.get(call.options.label ?? "") ?? [] };
        if (call.options.phase === "Verify") return { site: call.options.label, verdict: "confirmed", evidence: "traced" };
        return "THE REPORT";
      });
      expect(result).toBe("THE REPORT");

      const [reviews, verifies, reports] = (["Review", "Verify", "Report"] as const).map((phase) => calls.filter((call) => call.options.phase === phase));
      // Review: one agent per file, labelled with its path, with the file as its item context.
      expect(reviews!.map((call) => call.options.label)).toEqual(test1Input().files.map((file) => file.path));
      for (const call of reviews!) expect(call.prompt).toBe(`${instructions("review")}\n\nItem context:\n${JSON.stringify({ path: call.options.label }, null, 2)}`);
      // Dedupe: the kept findings are the ones Flywheel's own dedupe join keeps from the same reviews.
      const dedupe = latestReducer("dedupe");
      if (!dedupe) throw new Error("No dedupe reducer is registered");
      const slots = test1Input().files.map((file, ordinal) => ({ ordinal, key: file.path, branchNodeId: `review:${ordinal}`, disposition: "completed" as const, handoff: null, content: { findings: findings.get(file.path) ?? [] }, item: { path: file.path } }));
      const joined = dedupe.reduce({ items: "findings", by: "site" }, { slots, key: "path", source: null, contract: {}, earlierRounds: [] });
      const kept = joined["kept"];
      if (!Array.isArray(kept)) throw new Error("The dedupe join kept no list");
      expect(verifies!.map((call) => JSON.parse(call.prompt.slice(call.prompt.indexOf("\n{"))))).toEqual(kept);
      // Verify: one agent per kept finding, labelled with its site, as the Flywheel map labels each lane.
      expect(verifies!.map((call) => call.options.label)).toEqual(["src/orchestration/agent-runtime/llm/json-parse.ts:162", "src/orchestration/agent-runtime/llm/json-parse.ts:9"]);
      for (const call of verifies!) expect(call.prompt.startsWith(`${instructions("verify")}\n\nItem context:\n`)).toBe(true);
      // Report: one agent that reads the verify phase.
      expect(reports).toHaveLength(1);
      expect(reports![0]!.prompt.startsWith(`${instructions("report")}\n\nverify:\n`)).toBe(true);
      // Each structured agent gets the declared fields of its Flywheel step, and no agent names a model or an effort.
      expect(reviews![0]!.options.schema).toEqual(declaredSchema(authoredOutput("review")));
      expect(verifies![0]!.options.schema).toEqual(declaredSchema(authoredOutput("verify")));
      expect(reports![0]!.options.schema).toBeUndefined();
      for (const call of calls) expect(Object.keys(call.options).filter((key) => key === "model" || key === "effort")).toEqual([]);
    }
    expect(readFileSync(TEST1_WORKFLOW.flywheel, "utf8")).not.toMatch(/^\s*(?:model|effort):/mu);
  });

  it("states that a report names a shipped bug site only when it names the file and a line inside the site", () => {
    const [parser, completions] = SHIPPED_SITES;
    expect(namesShippedSite("json-parse.ts:162 completes a cut prefix", parser!)).toBe(true);
    expect(namesShippedSite("In `json-parse.ts` lines 150-170, the partial tier", parser!)).toBe(true);
    expect(namesShippedSite("json-parse.ts:40 has a typo", parser!)).toBe(false);
    expect(namesShippedSite("anthropic.ts:162 is wrong", parser!)).toBe(false);
    expect(namesShippedSite("openai-completions.ts line 144 maps length to max_tokens", completions!)).toBe(true);
  });
});
