/**
 * PooledSubprocessTransport — pool-based dispatcher invocation via warm processes.
 *
 * Acquires a warm process from the pool, sends the dispatcher prompt via stdin,
 * and reads the decision from a handoff file. Uses structural typing (PoolHandle
 * interface) to avoid importing from orchestration/.
 */

import type { DispatcherInput, DispatcherDecision } from "./schemas.js";
import type { DispatcherTransport } from "./transport.js";
import { buildDispatcherSystemPrompt, buildTruncationNotes } from "./system-prompt.js";
import { renderDispatcherHandoffInstruction } from "../queue/shared/handoff-render.js";
import { DispatcherDecisionHandoffSchema, type DispatcherDecisionHandoff } from "./schemas.js";
import { mapHandoffToDecision } from "./map-handoff.js";
import { buildDispatcherHandoffPath } from "../../infra/paths.js";

import {
  type PoolHandle,
  type PooledSpawnResult,
  invokePooled,
} from "../shared/invoke-pooled.js";

export type { PoolHandle, PooledSpawnResult };

export interface PooledSubprocessTransportOptions {
  /** Warm pool handle — injected by the orchestration layer. */
  pool: PoolHandle;
  /**
   * Format a prompt string as an NDJSON stdin message.
   * Injected to avoid importing from orchestration/engines/subprocess/.
   */
  formatStdinMessage: (text: string) => string;
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId: string;
  /** Project base directory for path resolution. */
  baseDir: string;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Called with each decoded stdout chunk as it arrives from the subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the subprocess. */
  onStderr?: (chunk: string) => void;
}

export class PooledSubprocessTransport implements DispatcherTransport {
  private readonly pool: PoolHandle;
  private readonly formatStdinMsg: (text: string) => string;
  private readonly sessionId: string;
  private readonly baseDir: string;
  private readonly logBaseDir?: string;
  private readonly onStdout?: (chunk: string) => void;
  private readonly onStderr?: (chunk: string) => void;

  constructor(options: PooledSubprocessTransportOptions) {
    this.pool = options.pool;
    this.formatStdinMsg = options.formatStdinMessage;
    this.sessionId = options.sessionId;
    this.baseDir = options.baseDir;
    this.logBaseDir = options.logBaseDir;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
  }

  async invoke(input: DispatcherInput): Promise<DispatcherDecision> {
    const systemPrompt = buildDispatcherSystemPrompt();
    const truncationNotes = buildTruncationNotes(input);
    const userContent = `${truncationNotes}Here is the dispatcher input:\n\n${JSON.stringify(input)}\n\nRespond with valid JSON only.`;

    return invokePooled<DispatcherDecisionHandoff, DispatcherDecision>(
      this.pool,
      {
        role: "dispatcher",
        buildHandoffPath: buildDispatcherHandoffPath,
        buildFullPrompt: (handoffPath) => {
          const handoffInstruction = renderDispatcherHandoffInstruction(handoffPath);
          return `${userContent}\n\n${handoffInstruction}`;
        },
        systemPrompt,
        handoffSchema: DispatcherDecisionHandoffSchema,
        mapResult: mapHandoffToDecision,
      },
      {
        sessionId: this.sessionId,
        baseDir: this.baseDir,
        formatStdinMessage: this.formatStdinMsg,
        logBaseDir: this.logBaseDir,
        onStdout: this.onStdout,
        onStderr: this.onStderr,
      },
    );
  }
}
