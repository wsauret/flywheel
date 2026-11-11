import type { OutputIssue } from "../output-contract/paths.js";

/** Terminal kinds a failed workflow worker can carry. */
export type AgentFailureKind =
  | "budget_exhausted"
  | "interrupted"
  | "input_closed"
  | "model_reassigned"
  | "output_overflow"
  | "api_error"
  | "model_unavailable"
  | "transient_disconnect"
  | "stream_stalled"
  | "api_overloaded"
  | "aborted";

/** Worker-facing verdict for a finished agent run. */
export type AgentOutcome =
  | { readonly output: "completed" | "context_overflow" }
  | {
      readonly output: "failed";
      readonly failureKind: AgentFailureKind;
      readonly failureMessage: string;
      readonly failureDetail: string;
    };

interface WorkerHandoffContent {
  readonly [key: string]: unknown;
}

/** Complete result returned by a workflow worker invocation. */
export type AgentOutput = AgentOutcome & {
  /** The output the handoff tool accepted, after its strict decode and every
   *  check. A worker returns no other content, so the attempt runner commits
   *  it without a second validation. */
  readonly handoffContent: WorkerHandoffContent | null;
  /** Present when the handoff tool never accepted a handoff and the agent's
   *  handoff correction ran out: `handoffContent` is then the last handoff
   *  it refused, after every repair, and these are its remaining problems.
   *  The attempt runner delivers it instead of failing the attempt. */
  readonly handoffIssues?: readonly OutputIssue[];
  readonly durationMs: number;
  readonly toolUses?: number;
};
