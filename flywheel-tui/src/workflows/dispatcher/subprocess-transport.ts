/**
 * SubprocessTransport — engine-aware dispatcher invocation via subprocess.
 *
 * Uses the engine registry to build commands with per-engine optimization flags.
 * Decision is read from a handoff file (not stdout parsing).
 * The dispatcher LLM writes a JSON decision to a file path included in the prompt.
 *
 * Delegates shared subprocess logic (engine resolution, binary check, retry loop,
 * handoff reading, subprocess logging) to subprocess-transport-base.
 */

import type { DispatcherInput, DispatcherDecision } from "./schemas.js";
import type { DispatcherTransport } from "./transport.js";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt.js";
import { renderDispatcherHandoffInstruction } from "../queue/shared/handoff-render.js";
import { DispatcherDecisionHandoffSchema, type DispatcherDecisionHandoff } from "./schemas.js";
import { mapHandoffToDecision } from "./map-handoff.js";
import { buildDispatcherHandoffPath } from "../../infra/paths.js";
import {
  type SubprocessTransportBaseOptions,
  type ResolvedTransportBase,
  resolveTransportBase,
  invokeSubprocess,
} from "../shared/subprocess-transport-base.js";

// ---------------------------------------------------------------------------
// SubprocessTransport
// ---------------------------------------------------------------------------

export interface SubprocessTransportOptions extends SubprocessTransportBaseOptions {
  /** Injected command builder — orchestration provides the engine-specific implementation. */
  buildCommand: (opts: { prompt: string; systemPrompt: string; tierConfig?: { model?: string; effort?: string } }) => { command: string; args: string[]; stdinPrompt: boolean };
}

export class SubprocessTransport implements DispatcherTransport {
  private readonly base: ResolvedTransportBase;
  private readonly buildCommand: SubprocessTransportOptions["buildCommand"];

  constructor(options: SubprocessTransportOptions) {
    this.base = resolveTransportBase(options);
    this.buildCommand = options.buildCommand;
  }

  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

    return invokeSubprocess<DispatcherDecisionHandoff, DispatcherDecision>(this.base, {
      role: "dispatcher",
      buildHandoffPath: buildDispatcherHandoffPath,
      buildFullPrompt: (handoffPath) => {
        const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath);
        return `${userContent}\n\n${handoffInstruction}`;
      },
      systemPrompt,
      buildEngineCommand: (prompt, sysPrompt, tierConfig) =>
        this.buildCommand({ prompt, systemPrompt: sysPrompt, tierConfig }),
      handoffSchema: DispatcherDecisionHandoffSchema,
      mapResult: mapHandoffToDecision,
    });
  }
}
