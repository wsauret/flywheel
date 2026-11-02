import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Schema } from "effect";
import type { OwnedProcess } from "../../../../infra/owned-subprocess.js";
import type { LauncherScope } from "../../../../infra/process-supervisor.js";
import type { Effort } from "../../../../infra/workflow-types.js";
import { captureBenchmarkPipe } from "./artifact-capture.js";
import { unavailableBenchmarkAccounting, type BenchmarkAccounting } from "./evidence.js";
import type { HeadlessBenchmarkExecution } from "./headless-execution-contract.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ModelUsage = Schema.Record(Schema.String, Schema.Struct({
  inputTokens: Count, outputTokens: Count, cacheReadInputTokens: Count, cacheCreationInputTokens: Count,
  costUSD: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)), costBasis: Schema.String,
}));
const Result = Schema.Struct({
  type: Schema.Literal("result"), subtype: Schema.String, is_error: Schema.Boolean, session_id: Schema.NonEmptyString,
  result: Schema.optionalKey(Schema.String), modelUsage: Schema.optionalKey(ModelUsage),
});
const Event = Schema.Struct({ type: Schema.NonEmptyString, session_id: Schema.optionalKey(Schema.NonEmptyString) });

export interface ClaudeCodeBenchmarkInput {
  readonly launcher: LauncherScope;
  readonly binaryPath: string;
  readonly projectRoot: string;
  readonly env: { readonly [name: string]: string | undefined };
  /** The model id exactly as the Claude Code CLI accepts it, such as `claude-sonnet-5-5`. */
  readonly model: string;
  readonly effort: Effort;
  readonly artifactDir: string;
  readonly message: string;
  /** Turn on Ultracode, Claude Code's standing opt-in to author and run a workflow for every substantive task. */
  readonly ultracode?: boolean;
  readonly wrapCommand: (command: readonly string[]) => readonly string[];
  readonly sessionId?: string;
}

function accounting(usage: typeof ModelUsage.Type | undefined): BenchmarkAccounting {
  if (!usage || Object.keys(usage).length === 0) return unavailableBenchmarkAccounting("Claude Code result supplied no modelUsage");
  const entries = Object.values(usage);
  const listed = entries.filter((entry) => entry.costBasis === "list");
  return {
    estimatedUsd: listed.length === entries.length
      ? { kind: "observed", value: listed.reduce((total, entry) => total + entry.costUSD, 0) }
      : { kind: "unavailable", reason: "Claude Code modelUsage has a non-list cost basis" },
    billedUsd: { kind: "unavailable", reason: "Claude Code reports list value, not billed spend" },
    tokens: { kind: "observed", value: entries.reduce((total, entry) => total + entry.inputTokens + entry.outputTokens + entry.cacheReadInputTokens + entry.cacheCreationInputTokens, 0) },
    providers: { kind: "unavailable", reason: "Claude Code modelUsage is not Flywheel provider attribution" },
    pricedEntryCount: listed.length, unpricedEntryCount: entries.length - listed.length,
  };
}

/** Run the resolved external binary in an owned sandbox without changing its ordinary login or configuration.
 * Stream result usage is list-value accounting, not canonical request or parent evidence.
 * Raw pipes and the session transcript tree are retained before the scope is released. Unsettled ownership throws. */
export async function executeClaudeCodeBenchmark(input: ClaudeCodeBenchmarkInput): Promise<HeadlessBenchmarkExecution> {
  const started = performance.now();
  await mkdir(input.artifactDir, { recursive: true, mode: 0o700 });
  const scope = input.launcher.open();
  const artifacts: { [name: string]: HeadlessBenchmarkExecution["artifacts"][string] } = {};
  let owned: OwnedProcess | undefined;
  let failure: string | undefined;
  let sessionId: string | undefined;
  let result: typeof Result.Type | undefined;
  let exitCode: number | null = null;
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    if (owned && !stopping) stopping = owned.terminate().catch(() => { failure ??= "Claude Code termination failed"; });
  };
  const consume = (line: string) => {
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    const event = Schema.decodeUnknownSync(Event)(value);
    sessionId ??= event.session_id;
    if (event.type === "result") {
      result = Schema.decodeUnknownSync(Result)(value);
      sessionId = result.session_id;
    }
  };
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parseChunk = async (chunk: Uint8Array) => {
    if (failure) return;
    try {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    } catch {
      failure = "Claude Code stream JSON or result validation failed";
      stop();
    }
  };
  let closure: Awaited<ReturnType<LauncherScope["close"]>>;
  try {
    try {
      owned = await scope.spawnOwned(input.wrapCommand([
        input.binaryPath, "-p", input.message, "--output-format", "stream-json", "--verbose",
        "--model", input.model, "--effort", input.effort, "--permission-mode", "bypassPermissions",
        ...(input.sessionId ? ["--session-id", input.sessionId] : []),
        // Plans have random names, so keep them with this project instead of opening the shared plans store.
        "--settings", JSON.stringify({ plansDirectory: ".claude/plans", ...(input.ultracode ? { ultracode: true } : {}) }),
      ]), {
        cwd: input.projectRoot, env: input.env,
        // The normal CLI holds this lock while saving refreshed credentials (ARCH-TOOLS-028).
        stopHold: { path: join(input.env.HOME ?? homedir(), ".claude", ".oauth_refresh.lock"), boundMs: 35_000 },
      });
      owned.stdin?.end();
      const pipes = await Promise.allSettled([
        captureBenchmarkPipe(owned.stdout, join(input.artifactDir, "stream.jsonl"), parseChunk, stop),
        captureBenchmarkPipe(owned.stderr, join(input.artifactDir, "stderr.txt"), undefined, stop),
      ]);
      for (const [index, pipe] of pipes.entries()) {
        if (pipe.status === "fulfilled") artifacts[index === 0 ? "stdout" : "stderr"] = pipe.value;
        else failure ??= "Claude Code pipe capture failed";
      }
      if (!failure) {
        try { consume(pending + decoder.decode()); }
        catch { failure = "Claude Code final stream record validation failed"; stop(); }
      }
      const exit = await owned.exited;
      exitCode = exit.code;
      if (exit.ownership !== "surrendered") failure ??= "Claude Code ownership not surrendered";
      await stopping;
    } catch {
      failure ??= "Claude Code launch or settlement failed";
      stop();
      await stopping;
    }
    if (sessionId && input.env.HOME) {
      try {
        // Session ids are globally unique. Discovering the containing project avoids duplicating Claude's path hashing.
        const projects = join(input.env.HOME, ".claude", "projects");
        const entries = await readdir(projects, { withFileTypes: true }).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
          throw error;
        });
        for (const project of entries) {
          if (!project.isDirectory()) continue;
          const root = join(projects, project.name);
          const transcript = Bun.file(join(root, `${sessionId}.jsonl`));
          if (!await transcript.exists()) continue;
          const target = join(input.artifactDir, "transcripts");
          await mkdir(target, { recursive: true, mode: 0o700 });
          artifacts.transcript = await captureBenchmarkPipe(transcript.stream(), join(target, `${sessionId}.jsonl`));
          const visit = async (source: string, destination: string): Promise<void> => {
            await mkdir(destination, { recursive: true, mode: 0o700 });
            for (const entry of await readdir(source, { withFileTypes: true })) {
              if (entry.isDirectory()) await visit(join(source, entry.name), join(destination, entry.name));
              else if (entry.isFile()) {
                const path = join(destination, entry.name);
                artifacts[`transcript-${Object.keys(artifacts).length}`] = await captureBenchmarkPipe(Bun.file(join(source, entry.name)).stream(), path);
              }
            }
          };
          const siblings = join(root, sessionId);
          // Main-only sessions have no subagent directory.
          const siblingsPresent = (await readdir(root)).includes(sessionId);
          if (siblingsPresent) await visit(siblings, join(target, sessionId));
          break;
        }
      } catch {
        failure ??= "Claude Code transcript artifact capture failed";
      }
    }
  } finally {
    closure = await scope.close();
  }
  if (!closure.settled) throw new Error(`Claude Code benchmark ownership unsettled: ${closure.reason}`);
  const success = !failure && exitCode === 0 && result?.subtype === "success" && !result.is_error;
  const text = success ? result?.result : undefined;
  const outcome = success ? text?.trim() ? "complete" : "incomplete" : "failed";
  return {
    version: 1, outcome, exitCode, wallMs: performance.now() - started,
    ...(sessionId ? { sessionId } : {}), ...(outcome === "complete" ? { handoff: { summary: text } } : {}),
    ...(outcome === "failed" ? { reason: failure ?? "Claude Code exited without a successful result" } : {}),
    ...(result?.modelUsage ? { models: Object.keys(result.modelUsage).sort() } : {}),
    evidence: { kind: "unavailable", reason: artifacts.transcript
      ? "Claude Code has no Flywheel canonical request or child-session evidence"
      : "Claude Code session transcript not found" },
    totalAccounting: accounting(result?.modelUsage),
    parentAccounting: unavailableBenchmarkAccounting("Claude Code modelUsage does not separate parent and descendants"),
    artifacts,
  };
}
