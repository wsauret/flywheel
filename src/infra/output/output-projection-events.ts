import type { MutationEvidence } from "../mutation-evidence.js";
import type { LlmToolOutputPart } from "../llm/tool-output-part-schema.js";
import type { StreamPhase, QuestionEntry, PausedBy, UserMessageImage, MessageSender } from "../output-blocks.js";
import type { ToolOutcome } from "../tool-outcome.js";

export interface ToolInput {
  [key: string]: unknown;
}

type QuestionAnswers = { [questionId in string]: string };

/** The content steps that settlement of a recorded assistant message
 *  reconciles into the transcript, applied without their live phase writes. */
export type SettledAssistantContent = Extract<OutputProjectionEvent, { type: "push-text" | "replace-text" | "push-thinking" | "retract-draft" | "tool-use" }>;

export type OutputProjectionEvent =
  | { type: "push-text"; text: string; timestamp: number; blockKey: string }
  | { type: "replace-text"; text: string; blockKey: string }
  // `estimatedTokens` is the provider's live thinking-token estimate for
  // redacted thinking, where `text` is empty; counted as tokens*4 chars.
  | { type: "push-thinking"; text: string; timestamp: number; parentToolUseId?: string; blockKey: string; estimatedTokens?: number }
  // Settlement arrives after the message streamed, possibly while one of its
  // foreground tools still runs, so it renders content and completes the
  // thinking blocks but never moves the live stream phase.
  | { type: "settle-assistant-message"; content: readonly SettledAssistantContent[]; timestamp: number }
  | { type: "complete-thinking"; timestamp: number }
  | { type: "complete-text"; timestamp: number; blockKey?: string }
  | { type: "begin-turn" }
  | { type: "set-model-phase"; phase: StreamPhase; timestamp: number }
  | { type: "push-user-message"; text: string; timestamp: number; entryId?: string; pending?: boolean; injected?: boolean; submissionIds?: readonly string[]; dispatchIds?: readonly string[]; images?: readonly UserMessageImage[]; from?: MessageSender }
  | { type: "push-system-message"; id?: string; message: string; timestamp: number; level?: "info" | "error"; mutationEvidence?: MutationEvidence }
  | { type: "push-divider"; label: string; timestamp: number }
  | { type: "tool-use"; toolUseId?: string; name: string; input?: ToolInput; timestamp: number; parentToolUseId?: string; nestedInCode?: true; leadingTextId?: string }
  | { type: "agent-tool-use"; agentId: string; toolUseId?: string; name: string; input?: ToolInput; timestamp: number }
  | { type: "tool-input-delta"; toolUseId: string; partialJson: string; parentToolUseId?: string }
  | { type: "tool-preview-check"; toolUseId: string; operation: { type: "set"; advice: string } | { type: "clear" } }
  | { type: "abandon-tool-inputs"; reason: "failed" | "interrupted" | "retry"; parentToolUseId?: string }
  | { type: "tool-execution-output"; toolUseId: string; output: string; parentToolUseId?: string }
  | { type: "tool-execution-output-recorded"; toolUseId: string; output: string; mutationEvidence?: MutationEvidence; parentToolUseId?: string }
  | { type: "tool-input-complete"; toolUseId: string; name: string; input: ToolInput; timestamp: number; parentToolUseId?: string; nestedInCode?: true; leadingTextId?: string }
  | { type: "tool-result"; toolUseId: string; outcome: ToolOutcome; content?: LlmToolOutputPart[]; timestamp: number; source?: "render" | "conversation" | "availability"; details?: unknown; executionOutputTail?: string; parentToolUseId?: string }
  | { type: "tool-result-ack"; toolUseId: string; parentToolUseId?: string }
  | { type: "push-question"; toolUseId: string; questions: QuestionEntry[]; timestamp: number }
  | { type: "answer-question"; toolUseId: string; answers: QuestionAnswers }
  | { type: "cancel-question"; toolUseId: string }
  | { type: "complete-agent"; agentId: string; durationMs: number; description?: string; label?: string }
  | { type: "fail-agent"; agentId: string; message: string }
  | { type: "interrupt-agent"; agentId: string; durationMs: number }
  | { type: "pause-agent"; agentId: string; timestamp: number; pausedBy: PausedBy }
  | { type: "agent-paused"; toolUseId: string; timestamp: number; pausedBy: PausedBy }
  | { type: "update-agent-meta"; agentId: string; label?: string; description?: string }
  | { type: "update-agent-latest-child"; agentId: string; text: string }
  | { type: "set-subagent-model"; toolUseId: string; model: string }
  | { type: "set-agent-link"; toolUseId: string; linkUri: string }
  | { type: "agent-dispatched"; toolUseId: string; timestamp: number }
  | { type: "agent-queued"; toolUseId: string; timestamp: number }
  // Drops the draft blocks a failed stream attempt pushed; the retry attempt
  // regenerates them under fresh blockKeys, so without retraction the partial
  // text survives beside the regeneration.
  | { type: "retract-draft"; blockKeys: readonly string[]; timestamp: number; reclassifiedChars?: number }
  | { type: "retract-thinking-drafts"; blockKeys: readonly string[]; timestamp: number }
  // "completed"/"paused" are turn boundaries (dispatched subagents keep their
  // blocks; their own settle path finishes them). "teardown" means the
  // session's runners are dying: every in-flight agent block is interrupted.
  | { type: "end-turn"; timestamp: number; finalStatus: "completed" | "paused" | "teardown" };
