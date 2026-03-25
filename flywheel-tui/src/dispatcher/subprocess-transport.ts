/**
 * SubprocessTransport — engine-aware dispatcher invocation via subprocess.
 *
 * Uses the engine registry to build commands with per-engine optimization flags.
 * - Claude Code: --print, --tools Write, --system-prompt, --no-session-persistence, --effort low, -p
 * - OpenCode: run --format json, --model, stdin prompt delivery
 *
 * Uses ProcessSpawner (DI seam, same pattern as worker).
 * Applies createEnvFilter() for env sanitization.
 * 60s timeout. On parse failure: retry ONCE with error feedback.
 *
 * Decision is read from a handoff file (not stdout parsing).
 * The dispatcher LLM writes a JSON decision to a file path included in the prompt.
 */

import * as nodePath from "node:path";
import * as fs from "node:fs";
import type { DispatcherInput, DispatcherDecision } from "../schemas/dispatcher";
import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import type { Engine } from "../engines/core/types";
import { createEnvFilter } from "../worker/env-filter";
import { getEngine } from "../engines/core/registry";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt";
import { renderDispatcherHandoffInstruction } from "../handoff/field-specs";
import { readHandoff, HandoffMissingError, HandoffInvalidError } from "../handoff/reader";
import { DispatcherDecisionHandoffSchema } from "../schemas/handoff";
import type { DispatcherDecisionHandoff } from "../schemas/handoff";
import { mapHandoffToDecision } from "./map-handoff";
import { Log } from "../utils/log";
import { HANDOFFS_DIR } from "../config/paths";

const log = Log.create({ service: "dispatcher-subprocess" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// SubprocessTransport
// ---------------------------------------------------------------------------

export interface SubprocessTransportOptions {
  spawner: ProcessSpawner;
  /** Engine name — "claude" or "opencode". Defaults to "opencode" for backward compatibility. */
  engineName?: string;
  /** Dispatcher model override — flows to --model CLI flag. Uses engine default when not set. */
  dispatcherModel?: string;
  /** Called with each decoded stdout chunk as it arrives from the dispatcher subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the dispatcher subprocess. */
  onStderr?: (chunk: string) => void;
}

export class SubprocessTransport implements DispatcherTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();
  private readonly engine: Engine;
  private readonly dispatcherModel: string | undefined;
  private readonly onStdout?: (chunk: string) => void;
  private readonly onStderr?: (chunk: string) => void;

  constructor(options: SubprocessTransportOptions) {
    this.spawner = options.spawner;
    this.dispatcherModel = options.dispatcherModel;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;

    // Resolve engine from registry — defaults to "opencode" for backward compat
    const engineName = options.engineName ?? "opencode";
    this.engine = getEngine(engineName);

    // Check binary availability upfront
    const binary = this.engine.metadata.cliBinary;
    if (!Bun.which(binary)) {
      throw new Error(
        `${binary} CLI not found — install it with: ${this.engine.metadata.installCommand} ` +
        `(or change the engine config to use a different engine)`,
      );
    }
  }

  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    const invocationId = crypto.randomUUID();
    const handoffsDir = nodePath.resolve(
      process.cwd(),
      HANDOFFS_DIR,
    );
    fs.mkdirSync(handoffsDir, { recursive: true });
    const handoffPath = nodePath.resolve(handoffsDir, `${invocationId}.json`);

    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

    // Append handoff instruction so the dispatcher writes its decision to a file
    const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath);
    const fullPrompt = `${userContent}\n\n${handoffInstruction}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryNote = attempt > 0
        ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please write valid JSON to the handoff file at \`${handoffPath}\`.`
        : "";

      // Build the engine-specific command via the registry
      const engineCmd = this.engine.buildDispatcherCommand({
        prompt: fullPrompt + retryNote,
        systemPrompt,
        model: this.dispatcherModel,
      });

      log.info("spawning dispatcher", {
        engine: this.engine.metadata.id,
        command: engineCmd.command,
        attempt: attempt + 1,
        model: this.dispatcherModel ?? "(default)",
        handoffPath,
      });

      const env = this.envFilter.filter(
        process.env as Record<string, string | undefined>,
      );

      // Determine stdin content — Claude uses -p flag (no stdin), OpenCode uses stdin
      const stdinContent = engineCmd.stdinPrompt
        ? `${systemPrompt}\n\n---\n\n${fullPrompt}${retryNote}`
        : undefined;

      const { result: resultPromise } = await this.spawner.spawn(
        engineCmd.command,
        engineCmd.args,
        {
          timeoutMs: CLI_TIMEOUT_MS,
          stdin: stdinContent,
          env,
          onStdout: this.onStdout,
          onStderr: this.onStderr,
        },
      );
      await resultPromise;

      // Read decision from handoff file (not stdout)
      try {
        const handoff: DispatcherDecisionHandoff = await readHandoff(
          handoffPath,
          DispatcherDecisionHandoffSchema,
        );
        return mapHandoffToDecision(handoff);
      } catch (err) {
        if (err instanceof HandoffMissingError || err instanceof HandoffInvalidError) {
          lastError = err;
          log.warn("dispatcher handoff read failed, retrying", {
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
      `Dispatcher subprocess failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  }
}


