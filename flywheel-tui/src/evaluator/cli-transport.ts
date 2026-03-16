/**
 * CliEvaluatorTransport — invokes the evaluator by spawning `opencode run --format json`.
 *
 * Same pattern as src/dispatcher/cli-transport.ts.
 * Spawns process, passes evaluator prompt via stdin, parses EvaluatorResultSchema from stdout.
 * Uses createEnvFilter() for env sanitization.
 * 30s timeout. On parse failure: retry ONCE with error feedback.
 */

import type { EvaluatorInput, EvaluatorResult } from "../schemas/evaluator";
import type { EvaluatorTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import { EvaluatorResultSchema } from "../schemas/evaluator";
import { createEnvFilter } from "../worker/env-filter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// CliEvaluatorTransport
// ---------------------------------------------------------------------------

export interface CliEvaluatorTransportOptions {
  spawner: ProcessSpawner;
}

export class CliEvaluatorTransport implements EvaluatorTransport {
  private readonly spawner: ProcessSpawner;
  private readonly envFilter = createEnvFilter();

  constructor(options: CliEvaluatorTransportOptions) {
    this.spawner = options.spawner;
  }

  async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
    const userMessage = this.buildPrompt(input);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const prompt =
        attempt === 0
          ? userMessage
          : `${userMessage}\n\n[RETRY] Previous attempt failed with error: ${lastError?.message}. Please output valid JSON matching the schema.`;

      const env = this.envFilter.filter(
        process.env as Record<string, string | undefined>,
      );

      const result = await this.spawner.spawn(
        "opencode",
        ["run", "--format", "json"],
        {
          timeoutMs: CLI_TIMEOUT_MS,
          stdin: prompt,
          env,
        },
      );

      // Try to parse the output
      const parseResult = this.parseOutput(result.output);
      if (parseResult.success) {
        return parseResult.data;
      }

      lastError = new Error(parseResult.error);
    }

    throw new Error(
      `Evaluator CLI failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private buildPrompt(input: EvaluatorInput): string {
    return [
      "You are an evaluator checking whether worker output meets the validation criteria.",
      "",
      "## Worker Output",
      input.worker_output,
      "",
      "## Validation Criteria",
      input.validation_criteria,
      "",
      input.context_files.length > 0
        ? `## Context Files\n${input.context_files.join("\n")}\n`
        : "",
      "## Instructions",
      'Evaluate the worker output against the validation criteria. Respond with valid JSON only, matching this schema:',
      '{ "passed": boolean, "reasoning": string, "suggestions": string[] }',
      "",
      "- passed: true if the output meets all criteria, false otherwise",
      "- reasoning: brief explanation of your evaluation",
      "- suggestions: optional array of improvement suggestions (only if passed is false)",
    ].join("\n");
  }

  private parseOutput(
    output: string,
  ):
    | { success: true; data: EvaluatorResult }
    | { success: false; error: string } {
    // Try to extract JSON from output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: false,
        error: `No JSON found in output: ${output.slice(0, 200)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return {
        success: false,
        error: `Invalid JSON: ${jsonMatch[0].slice(0, 200)}`,
      };
    }

    const result = EvaluatorResultSchema.safeParse(parsed);
    if (!result.success) {
      return {
        success: false,
        error: `Schema validation failed: ${result.error.message}`,
      };
    }

    return { success: true, data: result.data };
  }
}
