import { describe, expect, test } from "bun:test";

import { projectToolHistory } from "../../../../../src/orchestration/agent-runtime/llm/tool-history-projection.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { toAnthropicMessagesRequest } from "../../../../../src/orchestration/agent-runtime/llm/conversions/anthropic-messages.js";
import { toOpenAIResponsesInput } from "../../../../../src/orchestration/agent-runtime/llm/conversions/openai-responses.js";
import { toChatCompletionsMessages } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions-messages.js";
import { toGoogleGenerativeAiRequest } from "../../../../../src/orchestration/agent-runtime/llm/conversions/google-generative-ai.js";
import { openAIResponsesTarget } from "../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";

type AssistantMessage = Extract<ConversationMessage, { kind: "assistant" }>;
type ToolUseBlock = Extract<Exclude<AssistantMessage["content"], string>[number], { type: "tool_use" }>;

const result = (toolUseId: string, text: string): ConversationMessage => ({
  kind: "toolResult",
  toolUseId,
  content: [{ type: "text", text }],
});

function project(
  messages: readonly ConversationMessage[],
  activeRegistrationIds: ReadonlyMap<string, string>,
  legacy: ReadonlyMap<string, string> = new Map(),
) {
  return projectToolHistory({
    messages,
    activeRegistrationIds,
    historicalRegistrationId: (_message: AssistantMessage, block: ToolUseBlock) => legacy.get(block.name),
  });
}

describe("tool history projection", () => {
  test("preserves exact current registrations and provider-native metadata", () => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      provider: "openai",
      model: "gpt-5",
      content: [{
        type: "tool_use",
        id: "same",
        name: "apply_patch",
        registrationId: "apply_patch",
        input: { input: "patch" },
        providerCallId: "call_same",
        providerItemId: "item_same",
      }],
    }, result("same", "done")];

    const projected = project(messages, new Map([["apply_patch", "apply_patch"]]));

    expect(projected.projection).toBeUndefined();
    expect(projected.messages).toEqual(messages);
  });

  test("lowers changed contracts while preserving parallel current calls and result content", () => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      provider: "openai",
      model: "gpt-5",
      content: [
        { type: "text", text: "working" },
        { type: "tool_use", id: "old", name: "apply_patch", registrationId: "apply_patch", input: { input: "patch" } },
        { type: "tool_use", id: "current", name: "read", registrationId: "read", input: { path: "a.ts" }, providerCallId: "read-call" },
      ],
    }, result("old", "updated a.ts"), result("current", "file text")];

    const projected = project(messages, new Map([["edit", "edit"], ["read", "read"]]));
    const serialized = JSON.stringify(projected.messages);

    expect(projected.projection).toEqual({ loweredToolUseIds: ["old"] });
    expect(serialized).not.toContain("apply_patch");
    expect(serialized).not.toContain("patch\"");
    expect(serialized).toContain("updated a.ts");
    expect(projected.messages).toContainEqual(result("current", "file text"));
    expect(serialized).toContain("read-call");
    expect(messages[0]).toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ name: "apply_patch" })]) });
  });

  test("lowers a recorded call of the retired gpt-6-luna process registration under the native process", () => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      content: [{ type: "tool_use", id: "process-1", name: "process", registrationId: "process.luna", input: { action: "wait", process_id: "bash-bg-1", wait_sec: 30 } }],
    }, result("process-1", "completed")];

    const projected = project(messages, new Map([["process", "process.native"]]));
    const serialized = JSON.stringify(projected.messages);

    expect(projected.projection).toEqual({ loweredToolUseIds: ["process-1"] });
    expect(serialized).not.toContain("process.luna");
    expect(serialized).not.toContain("wait_sec");
    expect(serialized).toContain("completed");
  });

  test.each([
    ["edit", "edit", "apply_patch", "apply_patch"],
    ["apply_patch", "apply_patch", "edit", "edit"],
    ["exec", "exec", "bash", "bash"],
  ])("lowers %s (%s) history when the current presentation is %s (%s)", (oldName, oldRegistration, currentName, currentRegistration) => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      content: [{ type: "tool_use", id: "changed", name: oldName, registrationId: oldRegistration, input: { value: "old input" } }],
    }, result("changed", "useful result")];

    const projected = project(messages, new Map([[currentName, currentRegistration]]));

    expect(projected.projection).toEqual({ loweredToolUseIds: ["changed"] });
    expect(JSON.stringify(projected.messages)).not.toContain(oldName);
    expect(JSON.stringify(projected.messages)).toContain("useful result");
  });

  test("preserves legacy calls only when historical evidence resolves to the current registration", () => {
    const legacyCall = (name: string): ConversationMessage[] => [{
      kind: "assistant",
      content: [{ type: "tool_use", id: "legacy", name, input: { command: "pwd" } }],
    }, result("legacy", "/project")];
    const historical = new Map([["bash", "bash"], ["exec", "exec"]]);

    expect(project(legacyCall("bash"), new Map([["bash", "bash"]]), historical).projection).toBeUndefined();
    expect(project(legacyCall("exec"), new Map([["bash", "bash"]]), historical).projection)
      .toEqual({ loweredToolUseIds: ["legacy"] });
  });

  test("lowers an unresolved legacy call when no current registration exists", () => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      content: [{ type: "tool_use", id: "removed", name: "retired_tool", input: { value: "obsolete" } }],
    }, result("removed", "useful result")];

    const projected = project(messages, new Map());
    const serialized = JSON.stringify(projected.messages);

    expect(projected.projection).toEqual({ loweredToolUseIds: ["removed"] });
    expect(serialized).not.toContain("retired_tool");
    expect(serialized).not.toContain("obsolete");
    expect(serialized).toContain("removed");
    expect(serialized).toContain("useful result");
  });

  test("keeps neutral call and result linkage for parallel lowered operations", () => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      content: [
        { type: "tool_use", id: "operation-a", name: "exec", registrationId: "exec", input: { command: "first" } },
        { type: "tool_use", id: "operation-b", name: "exec", registrationId: "exec", input: { command: "second" } },
      ],
    }, result("operation-a", "first result"), result("operation-b", "second result")];

    const serialized = JSON.stringify(project(messages, new Map([["bash", "bash"]])).messages);

    expect(serialized.match(/operation-a/g)).toHaveLength(2);
    expect(serialized.match(/operation-b/g)).toHaveLength(2);
    expect(serialized).not.toContain("\"exec\"");
    expect(serialized).not.toContain("\"command\"");
  });

  test("gives every provider converter neutral history", () => {
    const messages: ConversationMessage[] = [{
      kind: "assistant",
      content: [{ type: "tool_use", id: "old", name: "exec", registrationId: "exec", input: { command: "pwd" } }],
    }, result("old", "/project")];
    const projected = project(messages, new Map([["bash", "bash"]])).messages;
    const wires = [
      toAnthropicMessagesRequest({ sharedHost: false, accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude" }, projected),
      toOpenAIResponsesInput({ sharedHost: false, accessProvider: "openai_api", provider: "openai", api: "openai-responses", model: "gpt-5" }, projected),
      toChatCompletionsMessages(projected, true, openAIResponsesTarget("openrouter", "test-model")),
      toGoogleGenerativeAiRequest({ accessProvider: "google_api", provider: "google", model: "gemini", supportsImages: true }, projected),
    ];

    for (const wire of wires) {
      expect(JSON.stringify(wire)).not.toContain("\"exec\"");
      expect(JSON.stringify(wire).match(/old/g)).toHaveLength(2);
      expect(JSON.stringify(wire)).toContain("/project");
    }
  });
});
