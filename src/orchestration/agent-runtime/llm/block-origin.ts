import type { ConversationMessage } from "./types.js";

/**
 * Who wrote one block of a request, read from the canonical entry that it came from while lowering still knows it
 * (ARCH-PROVIDERS-067): the person (also an entry of unknown origin, which no transport may rewrite), other runtime
 * input, an environment or date reminder, the Claude model reminder, another route's model reminder, the shared host's
 * framing, a tool notice, a tool result, or the assistant.
 */
export type BlockOrigin =
  | "person" | "system-input" | "runtime-reminder" | "claude-framing" | "model-framing" | "host-framing" | "tool-notice"
  | "tool-result" | "assistant";

/** Who wrote `message`, read from its canonical fields and never from its text. */
export function originOf(message: Exclude<ConversationMessage, { kind: "system" }>): BlockOrigin {
  switch (message.kind) {
    case "assistant": return "assistant";
    case "toolResult": return "tool-result";
    case "compactionSummary": return "system-input";
    case "user": break;
  }
  switch (message.framing) {
    case "reminder": return "runtime-reminder";
    case "claude": return "claude-framing";
    case "model": return "model-framing";
    case "agent-host": return "host-framing";
    case "tool-notice": return "tool-notice";
    case "turn-context": return "system-input";
    case undefined: return message.origin === "system" ? "system-input" : "person";
  }
}
