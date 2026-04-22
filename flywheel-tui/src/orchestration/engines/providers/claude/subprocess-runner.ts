import type {
  EngineRunner,
  EngineResult,
  EngineFailureReason,
  RunnerOptions,
} from "../../core/types.js";
import { resolveToolActions } from "../../core/tool-resolution.js";
import type { EngineCommand, EngineCommandOptions } from "./engine.js";
import type { ProcessSpawner, SpawnResult, StdinHandle } from "./subprocess/spawner.js";
import type { ProcessResult, ProcessFailureReason, UserEventToolResult } from "../../../../infra/ndjson-event-types.js";
import { formatStdinInput } from "./subprocess/stdin-format.js";
import { killProcessGroup } from "../../../../infra/process-lifecycle.js";

type CommandBuilder = (options: EngineCommandOptions) => EngineCommand;

interface SubprocessRunnerDeps {
  options: RunnerOptions;
  buildCommand: CommandBuilder;
  spawner: ProcessSpawner;
}

/**
 * Implements EngineRunner by wrapping a subprocess lifecycle.
 *
 * First `send()` spawns the process; subsequent calls write to the stdin pipe.
 * The `done` promise resolves when the subprocess exits, with the result
 * mapped from ProcessResult to EngineResult.
 */
export class SubprocessRunner implements EngineRunner {
  private readonly options: RunnerOptions;
  private readonly buildCommand: CommandBuilder;
  private readonly spawner: ProcessSpawner;

  private stdinHandle: StdinHandle | undefined;
  private childPid: number | undefined;
  private spawned = false;

  private readonly resolveResult: (result: EngineResult) => void;
  private readonly rejectResult: (error: unknown) => void;
  readonly done: Promise<EngineResult>;

  /** Session ID captured from the NDJSON stream (available after first output). */
  sessionId: string | undefined;

  constructor(deps: SubprocessRunnerDeps) {
    this.options = deps.options;
    this.buildCommand = deps.buildCommand;
    this.spawner = deps.spawner;

    const { promise, resolve, reject } = Promise.withResolvers<EngineResult>();
    this.done = promise;
    this.resolveResult = resolve;
    this.rejectResult = reject;
  }

  send(text: string): void {
    if (!this.spawned) {
      this.spawned = true;
      this.spawnAndRun(text);
      return;
    }

    if (!this.stdinHandle?.isOpen) return;
    this.stdinHandle.write(formatStdinInput(text));
  }

  sendToolResult(toolResult: UserEventToolResult): void {
    if (!this.stdinHandle?.isOpen) return;
    this.stdinHandle.write(formatStdinInput(toolResult));
  }

  end(): void {
    this.stdinHandle?.close();
  }

  abort(): void {
    if (this.childPid !== undefined) {
      killProcessGroup({ pid: this.childPid, kill: () => {} }, "SIGTERM");
    }
  }

  private spawnAndRun(text: string): void {
    const { options } = this;

    const engineCmd = this.buildCommand({
      model: options.model,
      resumeSessionId: options.resumeSessionId,
      systemPrompt: options.systemPrompt,
      effort: options.effort,
      tools: options.toolActions ? resolveToolActions("claude", options.toolActions) : options.tools,
      settings: options.claudeSettings,
    });

    const stdinContent = formatStdinInput(
      engineCmd.promptPrefix ? engineCmd.promptPrefix + text : text,
    );

    const env = options.extraEnv
      ? { ...(process.env as Record<string, string>), ...options.extraEnv }
      : undefined;

    const spawnPromise = this.spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: options.cwd,
      stdin: stdinContent,
      stdinPipe: true,
      onNDJSONEvent: options.onEvent,
      onSessionId: (id) => { this.sessionId = id; },
      onTurnComplete: options.onTurnComplete,
      signal: options.signal,
      env,
    });

    spawnPromise.then(
      (spawnResult) => this.handleSpawnResult(spawnResult),
      (err) => this.rejectResult(err),
    );
  }

  private handleSpawnResult(spawnResult: SpawnResult): void {
    this.stdinHandle = spawnResult.stdinHandle;
    this.childPid = spawnResult.pid;

    spawnResult.result.then(
      (subResult) => this.resolveResult(mapProcessResult(subResult)),
      (err) => this.rejectResult(err),
    );
  }
}

function mapFailure(failure: ProcessFailureReason): EngineFailureReason {
  switch (failure.kind) {
    case "timeout":
      return { kind: "timeout" };
    case "interrupted":
      return { kind: "aborted" };
    case "api_error":
      return { kind: "api_error", message: failure.message };
    case "rate_limited":
      return { kind: "api_error", message: failure.message };
    case "exit_code":
      return { kind: "exit_code", code: failure.exitCode };
    case "schema_error":
    case "transient":
    case "handoff_missing":
    case "handoff_invalid":
      return { kind: "api_error", message: failure.message };
  }
}

function mapProcessResult(sub: ProcessResult): EngineResult {
  return {
    durationMs: sub.durationMs,
    sessionId: sub.sessionId,
    failure: sub.failure ? mapFailure(sub.failure) : undefined,
  };
}
