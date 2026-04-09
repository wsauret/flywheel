/**
 * PooledSubprocessTransport — pool-based dispatcher invocation via warm processes.
 *
 * Acquires a warm process from the pool, sends the dispatcher prompt via stdin,
 * and reads the decision from a handoff file. Uses structural typing (PoolHandle
 * interface) to avoid importing from orchestration/.
 */

import type { DispatcherInput, DispatcherDecision } from "./schemas.js";
import type { DispatcherTransport } from "./transport.js";
import { buildDispatcherSystemPrompt } from "./system-prompt.js";
import { renderDispatcherHandoffInstruction } from "../queue/shared/handoff-render.js";
import { DispatcherDecisionHandoffSchema, type DispatcherDecisionHandoff } from "./schemas.js";
import { mapHandoffToDecision } from "./map-handoff.js";
import { buildInvocationHandoffPath } from "../../infra/paths.js";

import {
  type PoolHandle,
  type PooledSpawnResult,
  type BasePooledTransportOptions,
  invokePooled,
} from "../shared/invoke-pooled.js";

export type { PoolHandle, PooledSpawnResult };

export type PooledSubprocessTransportOptions = BasePooledTransportOptions;

export class PooledSubprocessTransport implements DispatcherTransport {
  constructor(private readonly opts: PooledSubprocessTransportOptions) {}

  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    const systemPrompt = buildDispatcherSystemPrompt();
    const userContent = `Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

    return invokePooled<DispatcherDecisionHandoff, DispatcherDecision>(
      this.opts.pool,
      {
        role: "dispatcher",
        buildHandoffPath: (sessionId, invocationId, baseDir) =>
          buildInvocationHandoffPath("dispatcher", sessionId, invocationId, baseDir),
        buildFullPrompt: (handoffPath) => {
          const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath);
          return `${userContent}\n\n${handoffInstruction}`;
        },
        systemPrompt,
        handoffSchema: DispatcherDecisionHandoffSchema,
        mapResult: mapHandoffToDecision,
      },
      this.opts,
    );
  }
}
