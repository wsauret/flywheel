import type { FileSink } from "bun";
import type { ProcessSpawner, SpawnOptions, SpawnResult, RawSpawnedProcess } from "./spawner.js";
import { createEnvFilter, type EnvFilterOptions } from "./env-filter.js";
import type { ChildHandle } from "../../../../../infra/process-lifecycle.js";
import { clampTimeoutMinutes, DEFAULT_TIMEOUT_MINUTES, createSubprocessTimeout } from "./timeout.js";
import { buildErrorResult, resolveHandoffPath } from "./spawn-helpers.js";
import { wireStreamPipeline } from "./stream-pipeline.js";
import { OutputBuffer } from "../../../../../infra/output-buffer.js";
import { CompletionDetector } from "./completion.js";
import { NDJSONParser } from "../../../../../infra/ndjson-parser.js";

const SHELL_METACHAR_REGEX = /[;&|`$(){}!<>]/;

function validateSpawnArgs(command: string) {
  if (SHELL_METACHAR_REGEX.test(command)) {
    throw new Error(`Shell metacharacter detected in command: ${command}`);
  }
}

function resolveCommandExecutable(command: string) {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }

  try {
    const resolved = Bun.which(command);
    if (resolved) return resolved;
  } catch {
    // Bun.which() can throw — fall through to fallbacks
  }

  if (command === "bun" && typeof process.execPath === "string" && process.execPath.length > 0) {
    return process.execPath;
  }

  return command;
}

interface BunSpawnerOptions {
  /** Environment filter configuration. */
  envFilter?: EnvFilterOptions;
  /** Timeout in minutes (1-120, default 60). */
  timeoutMinutes?: number;
}

export class BunProcessSpawner implements ProcessSpawner {
  private readonly envFilter;
  private readonly timeoutMs: number;

  constructor(options: BunSpawnerOptions = {}) {
    this.envFilter = createEnvFilter(options.envFilter);
    const minutes = clampTimeoutMinutes(options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES);
    this.timeoutMs = minutes * 60_000;
  }

  spawnRaw(command: string, args: string[], options?: SpawnOptions): RawSpawnedProcess {
    validateSpawnArgs(command);
    const executable = resolveCommandExecutable(command);

    const baseEnv = options?.env ?? (process.env as Record<string, string>);
    const filteredEnv = this.envFilter.filter(baseEnv);

    const usePipe = options?.stdinPipe === true;
    const stdinEncoded = !usePipe && options?.stdin !== undefined
      ? new TextEncoder().encode(options.stdin)
      : undefined;

    const proc = Bun.spawn([executable, ...args], {
      cwd: options?.cwd,
      env: filteredEnv,
      stdin: usePipe ? "pipe" : (stdinEncoded ?? "ignore"),
      stdout: "pipe",
      stderr: "pipe",
    });

    return {
      proc: proc as unknown as RawSpawnedProcess["proc"],
      stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: proc.stderr as unknown as ReadableStream<Uint8Array>,
      stdinSink: usePipe ? proc.stdin as FileSink : undefined,
    };
  }

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    try {
      const raw = this.spawnRaw(command, args, options);
      return wireStreamPipeline(raw, { timeoutMs, spawnOptions: options });
    } catch (error) {
      // Match the original error-handling: validation / spawn failures
      // are wrapped in a resolved SpawnResult with an error ProcessResult.
      const buffer = new OutputBuffer();
      const subprocessTimeout = createSubprocessTimeout(timeoutMs);
      const resultCtx = {
        ndjsonParser: new NDJSONParser(buffer),
        buffer,
        completionDetector: new CompletionDetector(),
        rawStdoutChunks: [] as string[],
        rawStderrChunks: [] as string[],
        subprocessTimeout,
        timeoutMs,
        startTime: Date.now(),
        handoffPath: resolveHandoffPath(options),
      };
      subprocessTimeout.cancel();
      return { result: Promise.resolve(buildErrorResult(resultCtx, error)) };
    }
  }
}
