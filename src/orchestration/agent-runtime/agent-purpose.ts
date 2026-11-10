import { assertNever } from "../../infra/assert-never.js";
import type { PromptKind } from "./system-prompt.js";
import type { AgentPurpose } from "./types.js";

export function promptKindForPurpose(purpose: AgentPurpose): PromptKind {
  switch (purpose.kind) {
    case "interactive-chat":
    case "chat-learning-review":
    case "chat-side-call":
    case "chat-routing-benchmark":
      return "chat";
    case "workflow-agent":
    case "workflow-follow-up":
    case "workflow-learning-review":
      return "workflow-agent";
    case "headless-task":
    case "unattended-chat":
    case "learning-review-audit":
    case "session-title":
    case "subagent-failure-summary":
      return "headless";
    case "persona-benchmark":
      return "subagent";
    case "subagent":
      return purpose.renderAs;
    default:
      return assertNever(purpose);
  }
}
