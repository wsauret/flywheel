/**
 * Shared subprocess transport base — extracts common logic used by both
 * dispatcher and evaluator subprocess transports.
 *
 * Shared structure:
 * 1. Constructor: engine resolution, binary check, env filter creation
 * 2. invoke(): retry loop with handoff reading, subprocess logging, error feedback
 *
 * Callers provide role-specific callbacks for prompt assembly, command building,
 * handoff path construction, and result mapping.
 */

import type { ZodType } from "zod";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../queue/shared/handoff-reader.js";
import { Log } from "../../infra/log.js";
import { type SubprocessRole, SubprocessLogger, createLoggedCallbacks } from "./subprocess-logger.js";
import { ensureSessionDir } from "../../infra/paths.js";

// ---------------------------------------------------------------------------
// Structural types — avoids importing from orchestration. Callers inject
// concrete implementations; TypeScript's structural typing ensures
// compatibility without a shared interface definition.
// ---------------------------------------------------------------------------

/** Minimal spawner contract needed by transport base. */
interface TransportSpawner {
  spawn(command: string, args: string[], options?: {
    timeoutMs?: number;
    stdin?: string;
    env?: Record<string, string>;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }): Promise<{ result: Promise<unknown> }>;
}

/** Minimal engine contract needed by transport base. */
interface TransportEngine {
  metadata: { id: string; cliBinary: string; installCommand: string };
}

/** Command returned by engine command builders. */
interface TransportEngineCommand {
  command: string;
  args: string[];
  stdinPrompt: boolean;
}

/** Environment filter contract. */
interface TransportEnvFilter {
  filter(env: Record<string, string | undefined>): Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Shared options — fields common to both dispatcher and evaluator transports
// ---------------------------------------------------------------------------

export interface SubprocessTransportBaseOptions {
  spawner: TransportSpawner;
  /** Resolved engine instance — injected by the orchestration layer. */
  engine: TransportEngine;
  /** Environment filter — injected by the orchestration layer. */
  envFilter: TransportEnvFilter;
  /** Resolved tier config blob (model, effort, future fields). Passed as one object to avoid per-field plumbing. */
  tierConfig?: { model?: string; effort?: string };
  /** Called with each decoded stdout chunk as it arrives from the subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the subprocess. */
  onStderr?: (chunk: string) => void;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId?: string;
  /** Project base directory for path resolution. */
  baseDir?: string;
}

// ---------------------------------------------------------------------------
// Resolved base — the immutable state after construction
// ---------------------------------------------------------------------------

export interface ResolvedTransportBase {
  readonly spawner: TransportSpawner;
  readonly envFilter: TransportEnvFilter;
  readonly engine: TransportEngine;
  readonly tierConfig: { model?: string; effort?: string };
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly logBaseDir?: string;
  readonly sessionId?: string;
  readonly baseDir: string;
}

/**
 * Resolve shared constructor logic: validate injected engine, check binary availability.
 *
 * Throws immediately if the engine binary is not found on PATH.
 */
export function resolveTransportBase(options: SubprocessTransportBaseOptions): ResolvedTransportBase {
  const { engine } = options;

  const binary = engine.metadata.cliBinary;
  if (!Bun.which(binary)) {
    throw new Error(
      `${binary} CLI not found — install it with: ${engine.metadata.installCommand} ` +
      `(or change the engine config to use a different engine)`,
    );
  }

  return {
    spawner: options.spawner,
    envFilter: options.envFilter,
    engine,
    tierConfig: options.tierConfig ?? {},
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    logBaseDir: options.logBaseDir,
    sessionId: options.sessionId,
    baseDir: options.baseDir ?? process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Invoke callbacks — role-specific behavior injected by callers
// ---------------------------------------------------------------------------

export interface InvokeCallbacks<THandoff, TResult> {
  /** Role label for logging (e.g. "dispatcher", "evaluator"). */
  role: SubprocessRole;
  /** Build the handoff file path for this invocation. */
  buildHandoffPath: (sessionId: string, invocationId: string, baseDir: string) => string;
  /** Build the full user prompt, including handoff instructions with the given handoff path. */
  buildFullPrompt: (handoffPath: string) => string;
  /** The system prompt (separate from user prompt for caching). */
  systemPrompt: string;
  /** Build the engine command for this invocation. Engine is available via closure from the caller. */
  buildEngineCommand: (prompt: string, systemPrompt: string, tierConfig: { model?: string; effort?: string }) => TransportEngineCommand;
  // Zod schemas with .default() have Input ≠ Output; widening Input avoids a false type mismatch
  handoffSchema: ZodType<THandoff, any, any>;
  /** Map the parsed handoff to the final result type. */
  mapResult: (handoff: THandoff) => TResult;
}

/**
 * Shared subprocess invocation with retry loop, handoff reading, and subprocess logging.
 *
 * Encapsulates the ~50 lines of nearly-identical retry logic used by both
 * dispatcher and evaluator subprocess transports.
 */
export async function invokeSubprocess<THandoff, TResult>(
  base: ResolvedTransportBase,
  callbacks: InvokeCallbacks<THandoff, TResult>,
): Promise<TResult> {
  const log = Log.create({ service: `${callbacks.role}-subprocess` });
  const invocationId = crypto.randomUUID();

  if (!base.sessionId) {
    throw new Error(`Subprocess${callbacks.role === "dispatcher" ? "Transport" : "EvaluatorTransport"} requires sessionId for handoff path construction`);
  }

  ensureSessionDir(base.sessionId, base.baseDir);
  const handoffPath = callbacks.buildHandoffPath(base.sessionId, invocationId, base.baseDir);
  const fullPrompt = callbacks.buildFullPrompt(handoffPath);

  // Create subprocess logger if logBaseDir is configured (OUTSIDE retry loop)
  const spLogger = base.logBaseDir
    ? new SubprocessLogger({ baseDir: base.logBaseDir, role: callbacks.role, invocationId, sessionId: base.sessionId })
    : null;
  const { onStdout: effectiveOnStdout, onStderr: effectiveOnStderr } = spLogger
    ? createLoggedCallbacks(spLogger, { onStdout: base.onStdout, onStderr: base.onStderr })
    : { onStdout: base.onStdout, onStderr: base.onStderr };

  let lastError: Error | null = null;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryNote = attempt > 0
        ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please write valid JSON to the handoff file at \`${handoffPath}\`.`
        : "";

      const engineCmd = callbacks.buildEngineCommand(
        fullPrompt + retryNote,
        callbacks.systemPrompt,
        base.tierConfig,
      );

      log.info(`spawning ${callbacks.role}`, {
        engine: base.engine.metadata.id,
        command: engineCmd.command,
        attempt: attempt + 1,
        model: base.tierConfig.model ?? "(default)",
        handoffPath,
      });

      const env = base.envFilter.filter(
        process.env as Record<string, string | undefined>,
      );

      // Determine stdin content — Claude uses -p flag (no stdin), OpenCode uses stdin
      const stdinContent = engineCmd.stdinPrompt
        ? `${callbacks.systemPrompt}\n\n---\n\n${fullPrompt}${retryNote}`
        : undefined;

      const { result: resultPromise } = await base.spawner.spawn(
        engineCmd.command,
        engineCmd.args,
        {
          timeoutMs: CLI_TIMEOUT_MS,
          stdin: stdinContent,
          env,
          onStdout: effectiveOnStdout,
          onStderr: effectiveOnStderr,
        },
      );
      await resultPromise;

      // Read result from handoff file (not stdout)
      try {
        const handoff = await readHandoff(handoffPath, callbacks.handoffSchema);
        return callbacks.mapResult(handoff);
      } catch (err) {
        if (err instanceof HandoffMissingError || err instanceof HandoffInvalidError) {
          lastError = err;
          log.warn(`${callbacks.role} handoff read failed, retrying`, {
            attempt: attempt + 1,
            error: err.message,
          });
          continue;
        }
        // Unexpected error — propagate
        throw err;
      }
    }

    throw new Error(
      `${callbacks.role.charAt(0).toUpperCase() + callbacks.role.slice(1)} subprocess failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  } finally {
    spLogger?.close();
  }
}
