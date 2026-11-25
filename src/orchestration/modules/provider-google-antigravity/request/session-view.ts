import { createHash } from "node:crypto";
import type { ReasoningEffort } from "../../../../infra/providers/llm/models/models.js";
import { renderSystemPrompt, type SystemPromptTiers } from "../../../agent-runtime/llm/system-prompt-tiers.js";
import type { ConversationMessage } from "../../../agent-runtime/llm/types.js";
import { renderMessage } from "./history-text.js";

/** A prompt that the bridge sends to an engine session and that canonical history never holds: the fixed primer that
 *  opens every session, or the fixed prompt of a rotation whose append holds the whole request (`CONTINUATION_PROMPT`
 *  after a tool result, `REPLY_PROMPT` after input too large for one prompt). `after` is the
 *  number of held messages before it. */
export interface SyntheticPrompt {
  readonly kind: "primer" | "continuation";
  readonly after: number;
}

/** What the session produced since the bridge last released work to it, which the next request's history must hold
 *  as one assistant message: a revealed tool call, which keeps the prompt open, or a final answer, which ends it.
 *  `fingerprint` is the `messageFingerprint` of that message as the engine produced it, so a request whose history
 *  holds it changed, for example by redaction, does not continue a session that holds the original. */
export type SessionOutput =
  | { readonly kind: "call"; readonly toolUseId: string; readonly fingerprint: string }
  | { readonly kind: "answer"; readonly fingerprint: string };

/**
 * What one engine session holds, in canonical terms. Canonical messages carry no ids, so the session names each
 * message by the fingerprint of the text that the model reads of it (`messageFingerprint`): metadata that no model
 * reads never makes a request look edited.
 */
export interface SessionView {
  /** The engine process that opened the session. */
  readonly processId: string;
  /** The fingerprint of the system prompt that the session's append holds. */
  readonly systemPromptHash: string;
  /** The fingerprints of the canonical messages that the session holds, in history order. */
  readonly held: readonly string[];
  /** How many of `held`, from the start, the session's append holds as text. */
  readonly covered: number;
  readonly synthetic: readonly SyntheticPrompt[];
  /** Undefined while a released step has not settled. */
  readonly output?: SessionOutput;
  /** Set when the bridge cancelled a prompt: the cancelled prompt stays in the engine's history (P7). */
  readonly cancelled: boolean;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** The context occupancy that the engine last reported (`usage_update.used`), in tokens. */
  readonly occupancy?: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function messageFingerprint(message: ConversationMessage): string {
  return sha256(renderMessage(message));
}

export function systemPromptHash(systemPrompt: SystemPromptTiers): string {
  return sha256(renderSystemPrompt(systemPrompt));
}
