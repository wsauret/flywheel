/**
 * Copilot per-request header derivation. The vision header must consider
 * tool-result images too: screenshot tools put images on the wire through all
 * three endpoint conversions (pi `github-copilot-headers.ts:11-21`).
 */

import { describe, expect, it } from "bun:test";
import { buildCopilotDynamicHeaders } from "../../../../../src/orchestration/modules/provider-github-copilot/headers.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const PNG = { type: "image" as const, mediaType: "image/png", data: "AAA" };

describe("buildCopilotDynamicHeaders", () => {
  it("sets the vision header for a user image", () => {
    const messages: ConversationMessage[] = [{ kind: "user", content: [{ type: "text", text: "look" }, PNG] }];
    expect(buildCopilotDynamicHeaders(messages)["Copilot-Vision-Request"]).toBe("true");
  });

  it("sets the vision header for a tool-result image", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "screenshot it" },
      { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }] },
      { kind: "toolResult", toolUseId: "c1", content: [PNG] },
    ];
    const headers = buildCopilotDynamicHeaders(messages);
    expect(headers["Copilot-Vision-Request"]).toBe("true");
    expect(headers["X-Initiator"]).toBe("agent");
  });

  it("omits the vision header for text-only conversations", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "hello" },
      { kind: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(buildCopilotDynamicHeaders(messages)["Copilot-Vision-Request"]).toBeUndefined();
  });
});
