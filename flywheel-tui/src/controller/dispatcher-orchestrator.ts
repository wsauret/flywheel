/**
 * DispatcherOrchestrator — bridges the dispatcher transport with the execution loop.
 *
 * Assembles input, calls dispatcher, returns crafted prompt.
 * On any dispatcher failure (after 2 retries): returns null so the caller falls through
 * to its own prompt builder.
 */

import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { DispatcherTransport } from "../dispatcher/transport";
import type { DispatcherDecision } from "../schemas/dispatcher";
import type { PhaseInfo } from "./phase-provider";
import type { AssemblerInput } from "../dispatcher/assemble";
import { assembleDispatcherInput } from "../dispatcher/assemble";
import { isPathWithinBoundary } from "../utils/path-security";
import { Log } from "../utils/log";
import * as fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatcherOrchestratorOptions {
  transport: DispatcherTransport;
  emitter: FlywheelEmitter;
  config: FlywheelConfig;
  workflowId: string;
}

/** Extended context for assembler — required fields per ADR spec. */
export interface PhasePromptOptions {
  workflowContext: AssemblerInput["workflowContext"];
  configContext: AssemblerInput["configContext"];
  sessionBudget: AssemblerInput["sessionBudget"];
  availableContext: AssemblerInput["availableContext"];
}

// ---------------------------------------------------------------------------
// Inline context budget (bytes)
// ---------------------------------------------------------------------------

/** Maximum bytes of file content to inline into a dispatcher prompt. */
export const INLINE_CONTENT_BUDGET = 8192;

const log = Log.create({ service: "dispatcher-orchestrator" });

// ---------------------------------------------------------------------------
// enrichPromptWithContext — Level 2 context inlining
// ---------------------------------------------------------------------------

/**
 * Prepend file contents from `contextToInline` to the dispatcher prompt.
 *
 * Files are read in order (dispatcher orders by importance — most critical first).
 * A greedy budget cap (`INLINE_CONTENT_BUDGET`) stops reading when the accumulated
 * byte count would exceed the limit. Non-existent files and paths outside
 * `projectCwd` are silently skipped with a log warning.
 */
export async function enrichPromptWithContext(
  prompt: string,
  contextToInline: string[],
  projectCwd: string,
): Promise<string> {
  if (contextToInline.length === 0) return prompt;

  const sections: string[] = [];
  let accumulatedBytes = 0;

  for (const filePath of contextToInline) {
    // Validate path is within project boundary
    if (!isPathWithinBoundary(filePath, projectCwd)) {
      log.warn("context_to_inline path outside project boundary, skipping", {
        path: filePath,
        projectCwd,
      });
      continue;
    }

    // Read file content
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      log.warn("context_to_inline file not readable, skipping", {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Check budget — greedy: stop when we'd exceed
    const contentBytes = Buffer.byteLength(content, "utf-8");
    if (accumulatedBytes + contentBytes > INLINE_CONTENT_BUDGET) {
      // If we haven't inlined anything yet, truncate this file to fit
      if (accumulatedBytes === 0) {
        const truncated = truncateToByteLimit(content, INLINE_CONTENT_BUDGET);
        sections.push(`### ${filePath}\n${truncated}\n[truncated]`);
        accumulatedBytes = Buffer.byteLength(truncated, "utf-8");
      }
      // Either way, stop processing further files
      break;
    }

    sections.push(`### ${filePath}\n${content}`);
    accumulatedBytes += contentBytes;
  }

  if (sections.length === 0) return prompt;

  const header = "## Relevant Context (from project standards and learnings)";
  const contextBlock = `${header}\n\n${sections.join("\n\n")}\n\n---\n\n`;
  return contextBlock + prompt;
}

/**
 * Truncate a string to fit within a byte budget (UTF-8).
 * Cuts at character boundaries to avoid breaking multi-byte sequences.
 */
function truncateToByteLimit(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.length <= maxBytes) return content;
  // Slice buffer and decode — Buffer.toString handles partial multi-byte gracefully
  return buf.subarray(0, maxBytes).toString("utf-8");
}

// ---------------------------------------------------------------------------
// DispatcherOrchestrator
// ---------------------------------------------------------------------------

export class DispatcherOrchestrator {
  private readonly transport: DispatcherTransport;
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly workflowId: string;

  constructor(options: DispatcherOrchestratorOptions) {
    this.transport = options.transport;
    this.emitter = options.emitter;
    this.config = options.config;
    this.workflowId = options.workflowId;
  }

  /**
   * Get the full dispatcher decision for a phase.
   *
   * Returns `null` if the dispatcher is disabled or fails, allowing
   * the caller to fall through to its own prompt builder.
   */
  async getPhaseDecision(
    phase: PhaseInfo,
    planContent: string,
    stateContent: string,
    contextContent: string | undefined,
    lastWorkerResult: string | undefined,
    options: PhasePromptOptions,
  ): Promise<DispatcherDecision | null> {
    // Emit dispatcher:invoked
    this.emitter.dispatcherInvoked(this.workflowId, phase.index, 0);

    const MAX_RETRIES = 2;
    const BACKOFF_MS = 1_000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Assemble input
        const assembled = assembleDispatcherInput({
          planContent,
          stateContent,
          contextContent,
          lastWorkerResult,
          workflowContext: options.workflowContext,
          configContext: options.configContext,
          sessionBudget: options.sessionBudget,
          availableContext: options.availableContext,
        });

        // Call dispatcher
        const decision = await this.transport.invoke(assembled.input);

        // Level 2: enrich prompt with inline context
        if (decision.context_to_inline && decision.context_to_inline.length > 0) {
          log.info("context_to_inline requested by dispatcher", {
            phaseIndex: phase.index,
            files: decision.context_to_inline,
          });
          const projectCwd = options.configContext.projectCwd;
          decision.prompt = await enrichPromptWithContext(
            decision.prompt,
            decision.context_to_inline,
            projectCwd,
          );
        }

        // Emit dispatcher:completed
        this.emitter.dispatcherCompleted(this.workflowId, decision);

        return decision;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (attempt < MAX_RETRIES) {
          log.warn("dispatcher attempt failed, retrying", {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            reason,
          });
          await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS * (attempt + 1)));
          continue;
        }

        // Final attempt failed — emit event and return null so caller uses its prompt builder
        this.emitter.dispatcherFailed(this.workflowId, reason);
        return null;
      }
    }

    // Should never reach here, but satisfy TypeScript
    return null;
  }

}
