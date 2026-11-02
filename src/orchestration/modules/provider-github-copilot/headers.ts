// Per-request headers GitHub Copilot's proxy expects on every chat call.
// `X-Initiator` switches budget accounting (user vs agent); `Openai-Intent`
// classifies the request for Copilot telemetry; `Copilot-Vision-Request`
// gates vision-model dispatch.
//
// Adapted from pi `packages/ai/src/api/github-copilot-headers.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.

import { trailingAlternatingMessage, type ConversationMessage } from "../../agent-runtime/llm/types.js";

interface StringFields { [key: string]: string }

export function copilotRequestInitiator(messages: readonly ConversationMessage[]): "user" | "agent" {
  const last = trailingAlternatingMessage(messages);
  if (!last) return "user";
  // Tool-call follow-ups are agent-initiated turns; Copilot's quota/budget
  // tracker classifies these as agent turns, not user turns. Matches pi
  // `github-copilot-headers.ts:5-8` (`last.role !== "user"`).
  return last.kind === "user" ? "user" : "agent";
}

function hasCopilotVisionInput(messages: ConversationMessage[]): boolean {
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    // Tool results carry image parts too (screenshot tools); all three endpoint
    // conversions put them on the wire, so they need the vision header exactly
    // like user images (pi `github-copilot-headers.ts:11-21`).
    for (const block of message.content) {
      if (block.type === "image") return true;
    }
  }
  return false;
}

export function buildCopilotDynamicHeaders(messages: ConversationMessage[]): StringFields {
  const headers: StringFields = {
    "X-Initiator": copilotRequestInitiator(messages),
    "Openai-Intent": "conversation-edits",
  };
  if (hasCopilotVisionInput(messages)) {
    headers["Copilot-Vision-Request"] = "true";
  }
  return headers;
}
