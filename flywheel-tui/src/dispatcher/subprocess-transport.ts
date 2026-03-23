/**
 * SubprocessTransport — invokes the dispatcher by spawning `opencode run --format json`.
 *
 * Uses ProcessSpawner (DI seam, same pattern as worker).
 * Passes assembled prompt + system prompt via stdin.
 * Applies createEnvFilter() for env sanitization.
 * 60s timeout. On parse failure: retry ONCE with error feedback.
 */

import type { DispatcherInput, DispatcherDecision } from "../schemas/dispatcher";
import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import { DispatcherDecisionSchema } from "../schemas/dispatcher";
import { createEnvFilter } from "../worker/env-filter";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt";

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
}

export class SubprocessTransport implements DispatcherTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();

  constructor(options: SubprocessTransportOptions) {
    this.spawner = options.spawner;
  }

  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;
    const userMessage = `${systemPrompt}\n\n---\n\n${userContent}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const prompt = attempt === 0
        ? userMessage
        : `${userMessage}\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please output valid JSON matching the schema.`;

      const env = this.envFilter.filter(
        process.env as Record<string, string | undefined>,
      );

      const { result: resultPromise } = await this.spawner.spawn(
        "opencode",
        ["run", "--format", "json"],
        {
          timeoutMs: CLI_TIMEOUT_MS,
          stdin: prompt,
          env,
        },
      );
      const result = await resultPromise;

      // Try to parse the output
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
    // Try to extract JSON from output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: `No JSON found in output: ${output.slice(0, 200)}` };
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
