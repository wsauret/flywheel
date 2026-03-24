/**
 * SubprocessTransport — engine-aware dispatcher invocation via subprocess.
 *
 * Uses the engine registry to build commands with per-engine optimization flags.
 * - Claude Code: --print, --tools "", --system-prompt, --no-session-persistence, --effort low, -p
 * - OpenCode: run --format json, --model, stdin prompt delivery
 *
 * Uses ProcessSpawner (DI seam, same pattern as worker).
 * Applies createEnvFilter() for env sanitization.
 * 60s timeout. On parse failure: retry ONCE with error feedback.
 */

import type { DispatcherInput, DispatcherDecision } from "../schemas/dispatcher";
import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import type { Engine, EngineCommand } from "../engines/core/types";
import { DispatcherDecisionSchema } from "../schemas/dispatcher";
import { createEnvFilter } from "../worker/env-filter";
import { getEngine } from "../engines/core/registry";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt";
import { Log } from "../utils/log";

const log = Log.create({ service: "dispatcher-subprocess" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 1;

/**
 * Extract AI response text from NDJSON output produced by `opencode run --format json`.
 * Parses each line as JSON and concatenates `part.text` from events with `type === "text"`.
 * Returns empty string if no text events found (caller falls back to raw output).
 */
function extractTextFromNDJSON(output: string): string {
  const parts: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "text" && typeof event.part?.text === "string") {
        parts.push(event.part.text);
      }
    } catch {
      // Not JSON — skip
    }
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// SubprocessTransport
// ---------------------------------------------------------------------------

export interface SubprocessTransportOptions {
  spawner: ProcessSpawner;
  /** Engine name — "claude" or "opencode". Defaults to "opencode" for backward compatibility. */
  engineName?: string;
  /** Dispatcher model override — flows to --model CLI flag. Uses engine default when not set. */
  dispatcherModel?: string;
}

export class SubprocessTransport implements DispatcherTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();
  private readonly engine: Engine;
  private readonly dispatcherModel: string | undefined;

  constructor(options: SubprocessTransportOptions) {
    this.spawner = options.spawner;
    this.dispatcherModel = options.dispatcherModel;

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
    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryNote = attempt > 0
        ? `\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please output valid JSON matching the schema.`
        : "";

      // Build the engine-specific command via the registry
      const engineCmd = this.engine.buildDispatcherCommand({
        prompt: userContent + retryNote,
        systemPrompt,
        model: this.dispatcherModel,
      });

      log.info("spawning dispatcher", {
        engine: this.engine.metadata.id,
        command: engineCmd.command,
        attempt: attempt + 1,
        model: this.dispatcherModel ?? "(default)",
      });

      const env = this.envFilter.filter(
        process.env as Record<string, string | undefined>,
      );

      // Determine stdin content — Claude uses -p flag (no stdin), OpenCode uses stdin
      const stdinContent = engineCmd.stdinPrompt
        ? `${systemPrompt}\n\n---\n\n${userContent}${retryNote}`
        : undefined;

      const { result: resultPromise } = await this.spawner.spawn(
        engineCmd.command,
        engineCmd.args,
        {
          timeoutMs: CLI_TIMEOUT_MS,
          stdin: stdinContent,
          env,
        },
      );
      const result = await resultPromise;

      // Parse output using engine-appropriate strategy
      const parseResult = this.parseOutput(result.output);
      if (parseResult.success) {
        return parseResult.data;
      }

      lastError = new Error(parseResult.error);
    }

    throw new Error(
      `Dispatcher subprocess failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  }

  private parseOutput(output: string): { success: true; data: DispatcherDecision } | { success: false; error: string } {
    // Engine-specific output parsing:
    // - OpenCode outputs NDJSON (newline-delimited JSON events)
    // - Claude Code --print outputs plain text (raw response)
    const isOpenCode = this.engine.metadata.id === "opencode";

    let source: string;
    if (isOpenCode) {
      const textContent = extractTextFromNDJSON(output);
      source = textContent || output;
    } else {
      // Claude Code --print: output is plain text, may contain JSON directly
      source = output;
    }

    const jsonMatch = source.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: `No JSON found in output: ${source.slice(0, 200)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { success: false, error: `Invalid JSON: ${jsonMatch[0].slice(0, 200)}` };
    }

    const result = DispatcherDecisionSchema.safeParse(parsed);
    if (!result.success) {
      return { success: false, error: `Schema validation failed: ${result.error.message}` };
    }

    return { success: true, data: result.data };
  }
}
