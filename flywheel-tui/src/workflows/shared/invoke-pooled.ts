/**
 * invokePooled — acquire a warm process from a pool, send a prompt via stdin,
 * await process exit, then read the handoff file.
 *
 * Shared by both PooledSubprocessTransport and PooledSubprocessEvaluatorTransport
 * (ADR-006 check #7: abstraction used in 2+ places). Encapsulates pool acquire/
 * release lifecycle, retry logic, handoff file reading, and subprocess logging —
 * genuine shared complexity, not trivial forwarding.
 *
 * Lives in workflows/shared/ (not orchestration/pool/) so that transports
 * in workflows/ can import it without violating module boundaries.
 */

import type { ZodType } from "zod";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../queue/shared/handoff-reader.js";
import { Log } from "../../infra/log.js";
import { ensureSessionDir } from "../../infra/paths.js";
import type { SubprocessRole } from "./subprocess-logger.js";
import { SubprocessLogger, createLoggedCallbacks } from "./subprocess-logger.js";

// Structural types — callers inject concrete implementations.

/** Minimal stdin handle contract. */
interface StdinHandle {
  write(message: string): boolean;
  close(): void;
  readonly isOpen: boolean;
}

/** Minimal spawn result contract — what pool.acquire() returns. */
export interface PooledSpawnResult {
  result: Promise<{ exitCode: number; output: string; [key: string]: unknown }>;
  stdinHandle?: StdinHandle;
  pid?: number;
}

/** Minimal pool contract — structural typing for DI. */
export interface PoolHandle {
  acquire(): Promise<PooledSpawnResult>;
  release(proc: PooledSpawnResult): void;
}

// Callbacks — role-specific behavior injected by callers

export interface InvokePooledCallbacks<THandoff, TResult> {
  /** Role label for logging (e.g. "dispatcher", "evaluator"). */
  role: SubprocessRole;
  /** Build the handoff file path for this invocation. */
  buildHandoffPath: (sessionId: string, invocationId: string, baseDir: string) => string;
  /** Build the full user prompt, including handoff instructions with the given handoff path. */
  buildFullPrompt: (handoffPath: string) => string;
  /** The system prompt — prepended to the stdin message. */
  systemPrompt: string;
  /** Zod schema for handoff file validation.
   * `any` on Def/Input generics: schemas with `.default()` fields have Input !== Output,
   * so `ZodType<T>` (which defaults Input = Output) rejects them. */
  handoffSchema: ZodType<THandoff, any, any>;
  /** Map the parsed handoff to the final result type. */
  mapResult: (handoff: THandoff) => TResult;
}

// Options

export interface InvokePooledOptions {
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId: string;
  /** Project base directory for path resolution. */
  baseDir: string;
  /**
   * Format a prompt string as an NDJSON stdin message.
   * Injected to avoid importing from orchestration/engines/subprocess/.
   */
  formatStdinMessage: (text: string) => string;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Called with each decoded stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
}

/**
 * Shared options for pooled subprocess transports.
 * Both PooledSubprocessTransport and PooledSubprocessEvaluatorTransport
 * share this shape — only the evaluator adds `systemPromptAddendum`.
 *
 * Extends InvokePooledOptions so callers can pass this directly to
 * invokePooled() — TypeScript's structural typing accepts the extra
 * `pool` field without an extraction step.
 */
export interface BasePooledTransportOptions extends InvokePooledOptions {
  /** Warm pool handle — injected by the orchestration layer. */
  pool: PoolHandle;
}

// Constants

const MAX_RETRIES = 1;

// invokePooled

/**
 * Acquire a warm process from the pool, send a prompt via stdin, await exit,
 * read the handoff file, and release the process back to the pool.
 *
 * On `HandoffMissingError` or `HandoffInvalidError`: releases the current
 * process, acquires a fresh one from the pool, and retries once.
 */
export async function invokePooled<THandoff, TResult>(
  pool: PoolHandle,
  callbacks: InvokePooledCallbacks<THandoff, TResult>,
  options: InvokePooledOptions,
): Promise<TResult> {
  const log = Log.create({ service: `${callbacks.role}-pooled` });
  const invocationId = crypto.randomUUID();

  ensureSessionDir(options.sessionId, options.baseDir);
  const handoffPath = callbacks.buildHandoffPath(options.sessionId, invocationId, options.baseDir);

  // Create subprocess logger if logBaseDir is configured (OUTSIDE retry loop)
  const spLogger = options.logBaseDir
    ? new SubprocessLogger({
        baseDir: options.logBaseDir,
        role: callbacks.role,
        invocationId,
        sessionId: options.sessionId,
      })
    : null;
  const { onStdout: effectiveOnStdout, onStderr: effectiveOnStderr } = spLogger
    ? createLoggedCallbacks(spLogger, { onStdout: options.onStdout, onStderr: options.onStderr })
    : { onStdout: options.onStdout, onStderr: options.onStderr };

  let lastError: Error | null = null;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryNote = attempt > 0
        ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please write valid JSON to the handoff file at \`${handoffPath}\`.`
        : "";

      const fullPrompt = callbacks.buildFullPrompt(handoffPath);
      const stdinContent = `${callbacks.systemPrompt}\n\n---\n\n${fullPrompt}${retryNote}`;
      const ndjsonMessage = options.formatStdinMessage(stdinContent);

      const proc = await pool.acquire();

      log.info(`acquired warm process for ${callbacks.role}`, {
        attempt: attempt + 1,
        pid: proc.pid,
        handoffPath,
      });

      try {
        if (!proc.stdinHandle) {
          throw new Error(`Pooled process has no stdin handle (pid=${proc.pid})`);
        }

        proc.stdinHandle.write(ndjsonMessage);
        proc.stdinHandle.close();

        const result = await proc.result;

        if (result.output && effectiveOnStdout) {
          effectiveOnStdout(result.output);
        }

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
        throw err;
      } finally {
        pool.release(proc);
      }
    }

    throw new Error(
      `${callbacks.role.charAt(0).toUpperCase() + callbacks.role.slice(1)} pooled invoke failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  } finally {
    spLogger?.close();
  }
}
