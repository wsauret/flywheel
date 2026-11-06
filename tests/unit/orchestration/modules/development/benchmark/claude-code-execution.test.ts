import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LauncherScope } from "../../../../../../src/infra/process-supervisor.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import { executeClaudeCodeBenchmark } from "../../../../../../src/orchestration/modules/development/benchmark/claude-code-execution.js";
import { HeadlessBenchmarkExecutionSchema } from "../../../../../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { Schema } from "effect";

const temporary = temporaryDirectories();
// Selected fields from the real 2.1.296 stream, including its auxiliary Haiku usage.
const result = {
  type: "result", subtype: "success", is_error: false, session_id: "session", num_turns: 3,
  result: "Changed subtraction to addition.", total_cost_usd: 0.1140652,
  modelUsage: {
    "claude-haiku-5-5": { inputTokens: 1185, outputTokens: 13, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000125, costBasis: "list" },
    "claude-sonnet-5-5": { inputTokens: 6, outputTokens: 304, cacheReadInputTokens: 81802, cacheCreationInputTokens: 25677, costUSD: 0.11394019999999999, costBasis: "list" },
  },
};

/** The result fields a case overrides. */
interface ResultPatch {
  readonly result?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
}

async function subject(patch: ResultPatch = {}, exitCode = 0, malformed?: string, transcripts: "present" | "missing-main" | "missing-projects" = "present") {
  const root = temporary("claude-execution-");
  const home = join(root, "home");
  const project = join(home, ".claude", "projects", "-scratch-project");
  if (transcripts !== "missing-projects") {
    await mkdir(join(project, "session", "subagents", "workflows", "run"), { recursive: true });
    if (transcripts === "present") await writeFile(join(project, "session.jsonl"), "main transcript\n");
    await writeFile(join(project, "session", "subagents", "agent-child.jsonl"), "child transcript\n");
    await writeFile(join(project, "session", "subagents", "workflows", "run", "agent-step.jsonl"), "workflow transcript\n");
  }
  const stream = [
    { type: "system", subtype: "hook_started", session_id: "session" },
    { type: "system", subtype: "init", session_id: "session", cwd: "/scratch/project", model: "claude-sonnet-5-5", claude_code_version: "2.1.296" },
    { type: "assistant", session_id: "session", message: { model: "claude-sonnet-5-5" } },
    { ...result, ...patch },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n" + (malformed ?? "");
  const launches: { command: readonly string[]; env: unknown; stopHold: unknown }[] = [];
  let closed = 0;
  const pipe = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
  const exit = { code: exitCode, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const };
  const scope: LauncherScope = {
    open: () => scope, adoptOwned: async () => { throw new Error("no adoption"); },
    close: async () => { closed++; return { settled: true }; },
    spawnOwned: async (command, options) => {
      launches.push({ command, env: options?.env, stopHold: options?.stopHold });
      return { pid: 1, token: "fake", stdin: undefined, stdout: pipe(stream), stderr: pipe("diagnostic\n"), exited: Promise.resolve(exit), terminate: async () => exit };
    },
  };
  return {
    launches, closed: () => closed, stream,
    input: { launcher: scope, binaryPath: "/scratch/claude-real", projectRoot: "/scratch/project", artifactDir: join(root, "artifacts"),
      env: { HOME: home, TMPDIR: join(root, "tmp") }, model: "claude-sonnet-5-5", effort: "medium" as const, message: "fix",
      wrapCommand: (command: readonly string[]) => ["sandbox", ...command] },
  };
}

test("runs the resolved binary normally and retains stream, stderr, transcript tree, and modelUsage accounting", async () => {
  const fixture = await subject();
  const execution = await executeClaudeCodeBenchmark({ ...fixture.input, sessionId: "session" });
  Schema.decodeUnknownSync(HeadlessBenchmarkExecutionSchema, { onExcessProperty: "error" })(execution);
  expect(execution.outcome).toBe("complete");
  expect(execution.handoff).toEqual({ summary: result.result });
  expect(fixture.launches).toEqual([{ command: ["sandbox", "/scratch/claude-real", "-p", "fix", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-5-5", "--effort", "medium", "--permission-mode", "bypassPermissions", "--session-id", "session", "--settings", '{"plansDirectory":".claude/plans"}'], env: fixture.input.env, stopHold: { path: join(fixture.input.env.HOME, ".claude", ".oauth_refresh.lock"), boundMs: 35_000 } }]);
  expect(execution.totalAccounting.tokens).toEqual({ kind: "observed", value: 108987 });
  expect(execution.totalAccounting.estimatedUsd.kind).toBe("observed");
  if (execution.totalAccounting.estimatedUsd.kind === "observed") expect(execution.totalAccounting.estimatedUsd.value).toBeCloseTo(0.1140652);
  expect(execution.totalAccounting.billedUsd.kind).toBe("unavailable");
  expect(execution.parentAccounting.tokens.kind).toBe("unavailable");
  expect(execution.evidence.kind).toBe("unavailable");
  expect(execution.models).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  const contents = await Promise.all(Object.values(execution.artifacts).map((artifact) => readFile(artifact.path, "utf8")));
  expect(contents).toContain(fixture.stream);
  expect(contents).toContain("diagnostic\n");
  expect(contents).toContain("main transcript\n");
  expect(contents).toContain("child transcript\n");
  expect(contents).toContain("workflow transcript\n");
  expect(fixture.closed()).toBe(1);
});

test("turns on Ultracode through the session settings when the treatment asks for it", async () => {
  const fixture = await subject();
  await executeClaudeCodeBenchmark({ ...fixture.input, ultracode: true });
  const command = fixture.launches[0]!.command;
  expect(JSON.parse(command[command.indexOf("--settings") + 1]!)).toEqual({ plansDirectory: ".claude/plans", ultracode: true });
});

test("loads a plugin directory after the ordinary arguments when the treatment names one", async () => {
  const fixture = await subject();
  await executeClaudeCodeBenchmark({ ...fixture.input, pluginDir: "/scratch/plugin" });
  expect(fixture.launches[0]!.command).toEqual(["sandbox", "/scratch/claude-real", "-p", "fix", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-5-5", "--effort", "medium", "--permission-mode", "bypassPermissions", "--settings", '{"plansDirectory":".claude/plans"}', "--plugin-dir", "/scratch/plugin"]);
});

test.each(["missing-main", "missing-projects"] as const)("keeps a successful stream outcome and reports a missing transcript: %s", async (transcripts) => {
  const fixture = await subject({}, 0, undefined, transcripts);
  const execution = await executeClaudeCodeBenchmark(fixture.input);
  expect(execution.outcome).toBe("complete");
  expect(execution.handoff).toEqual({ summary: result.result });
  expect(execution.evidence).toEqual({ kind: "unavailable", reason: "Claude Code session transcript not found" });
  expect(execution.artifacts.transcript).toBeUndefined();
  expect(fixture.closed()).toBe(1);
});

test.each([
  { patch: { result: "" }, code: 0, outcome: "incomplete" },
  { patch: {}, code: 1, outcome: "failed" },
  { patch: { subtype: "error_during_execution", is_error: true }, code: 0, outcome: "failed" },
  { patch: {}, code: 0, malformed: "not-json\n", outcome: "failed" },
])("settles $outcome without fabricating a handoff", async ({ patch, code, malformed, outcome }) => {
  const fixture = await subject(patch, code, malformed);
  const execution = await executeClaudeCodeBenchmark(fixture.input);
  expect(execution.outcome).toBe(outcome);
  expect(execution.handoff).toBeUndefined();
  expect(fixture.closed()).toBe(1);
});
