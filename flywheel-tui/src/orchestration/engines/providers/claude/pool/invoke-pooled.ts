import type { ZodType } from "zod";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../../../../../workflows/queue/shared/handoff-reader.js";
import { formatStdinInput } from "../subprocess/stdin-format.js";
import { ensureSessionDir } from "../../../../../infra/paths.js";
import { Log } from "../../../../../infra/log.js";
import type { SpawnResult, StdinHandle } from "../subprocess/spawner.js";
import type { WarmPool } from "./warm-pool.js";

interface InvokePooledCallbacks<THandoff, TResult> {
  role: string;
  buildHandoffPath: (sessionId: string, invocationId: string, baseDir: string) => string;
  buildFullPrompt: (handoffPath: string) => string;
  systemPrompt: string;
  // Zod's ZodType<Output, Def, Input> requires `any` for Def/Input
  // when schemas use .passthrough() (Input != Output).
  handoffSchema: ZodType<THandoff, any, any>;
  mapResult: (handoff: THandoff) => TResult;
}

interface InvokePooledOptions {
  sessionId: string;
  baseDir: string;
}

const MAX_RETRIES = 1;

export async function invokePooled<THandoff, TResult>(
  pool: WarmPool<SpawnResult>,
  callbacks: InvokePooledCallbacks<THandoff, TResult>,
  options: InvokePooledOptions,
): Promise<TResult> {
  const log = Log.create({ service: `${callbacks.role}-pooled` });
  const invocationId = crypto.randomUUID();

  ensureSessionDir(options.sessionId, options.baseDir);
  const handoffPath = callbacks.buildHandoffPath(options.sessionId, invocationId, options.baseDir);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const retryNote = attempt > 0
      ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please write valid JSON to the handoff file at \`${handoffPath}\`.`
      : "";

    const fullPrompt = callbacks.buildFullPrompt(handoffPath);
    const stdinContent = `${callbacks.systemPrompt}\n\n---\n\n${fullPrompt}${retryNote}`;
    const ndjsonMessage = formatStdinInput(stdinContent);

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

      await proc.result;

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
}
