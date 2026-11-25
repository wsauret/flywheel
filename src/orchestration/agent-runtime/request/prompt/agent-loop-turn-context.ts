import { redactSecrets } from "../../../../infra/redact-secrets.js";
import { CONTINUATION_MESSAGES } from "../../../session/conversation/turn-end-record.js";
import type { ConversationMessage } from "../../../../infra/llm/conversation/conversation-message.js";

/** One turn-context entry, before the redaction boundary stamps its origin. */
export const turnContextEntry = (content: string): ConversationMessage => ({ kind: "user", content, framing: "turn-context" });

/** Whether the current turn of `history`, after its last person input, already holds `text` as a turn-context entry,
 *  alone or followed by a progress reminder. Its redacted form is what the history holds. */
function holdsTurnContext(history: readonly ConversationMessage[], text: string): boolean {
  const recorded = redactSecrets(text);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    // SAFETY: index stays within the bounds of history.
    const message = history[index]!;
    if (message.kind !== "user") continue;
    if (message.origin === "human") return false;
    if (message.framing === "turn-context" && typeof message.content === "string"
      && (message.content === recorded || message.content.startsWith(`${recorded}\n\n`))) return true;
  }
  return false;
}

/**
 * The standing context of a logical turn, such as a command's instructions or a headless run's guidance
 * (ARCH-CONTEXT-042). The first request records it once, as a turn-context entry, and later requests carry that entry
 * in place, so the history before it never changes. A new life of the same turn, such as a recovery, finds the entry
 * in its resumed history and records nothing. A reset records it again after the opening of the fresh context. A
 * person turn ends it. It also holds the notice of each stalled response until the request that recovers from it.
 */
export function createTurnContext(initial: string | undefined, history: readonly ConversationMessage[]) {
  let text = initial;
  let recorded = initial !== undefined && holdsTurnContext(history, initial);
  let stalls = 0;
  return {
    /** A command's turn starts with its own context, which the next request records. */
    start(next: string): void {
      text = next;
      recorded = false;
    },
    end(): void {
      text = undefined;
    },
    /** The context of the turn, which a reset records after its opening. */
    standing: (): string | undefined => text,
    /** A reset replaced the history with a fresh context that records the standing context. */
    reset(): void {
      recorded = true;
    },
    /** The context that the history does not hold yet, which the next request records. Returns it once. */
    take(): string | undefined {
      // A new request cycle recovers from no stall: a walk that gave up records none of its notices.
      stalls = 0;
      const unrecorded = recorded ? undefined : text;
      recorded = true;
      return unrecorded;
    },
    /** A response of the current request stalled. */
    stalled(): void {
      stalls += 1;
    },
    /** The notice of each stall since the last take, which the walk records as it prepares the request that recovers
     *  from them. Returns them once. */
    takeStallNotices(): ConversationMessage[] {
      const notices = Array.from({ length: stalls }, (): ConversationMessage => ({ kind: "user", content: CONTINUATION_MESSAGES.stream_stalled }));
      stalls = 0;
      return notices;
    },
  };
}
