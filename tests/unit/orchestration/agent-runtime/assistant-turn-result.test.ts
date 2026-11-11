import { describe, expect, test } from "bun:test";
import { handleStreamEvent, type AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js";

function result(): AssistantTurnResult {
  return {
    entryId: "entry",
    outcome: { kind: "ok", stopReason: "unknown" },
    assistantContent: [],
    toolCalls: [],
    assistantMetadata: undefined,
    lastAssistantMetadata: undefined,
    usageAnchor: undefined,
    terminalEvent: undefined,
    transportContext: undefined,
  };
}

describe("assistant turn terminal reconciliation", () => {
  test("retains cache writes and reported reasoning in the request usage anchor", () => {
    const turn = result();
    handleStreamEvent({
      kind: "usage", final: true,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreateTokens: 40,
      reasoningTokens: 7,
    }, turn);
    expect(turn.usageAnchor).toEqual({ inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 7 });
  });

  test("authoritative terminal text replaces an interleaved provisional block", () => {
    const turn = result();
    handleStreamEvent({ kind: "text_delta", text: "draft", blockKey: "message:1" }, turn);
    handleStreamEvent({ kind: "text_delta", text: "other", blockKey: "message:2" }, turn);
    const terminal = handleStreamEvent({ kind: "text_terminal", content: "final", blockKey: "message:1", signature: "signed" }, turn);
    expect(terminal).toMatchObject({ content: "finalother", outputIdentity: { entryId: "entry", blockKey: "entry:0" } });
    expect(turn.assistantContent).toEqual([
      { type: "text", text: "final", signature: "signed" },
      { type: "text", text: "other" },
    ]);
  });

  test("publishes original run coordinates across adjacent text, hidden parts, progress, narration, and tools", () => {
    const turn = result();
    const preview = handleStreamEvent({ kind: "thinking_delta", text: "unfinished private preview", blockKey: "preview" }, turn);
    const first = handleStreamEvent({ kind: "text_delta", blockKey: "one", text: "same" }, turn);
    const adjacent = handleStreamEvent({ kind: "text_delta", blockKey: "two", text: " words" }, turn);
    const reasoning = handleStreamEvent({ kind: "reasoning", id: "opaque", encryptedContent: "encrypted", blockKey: "summary" }, turn);
    const afterHidden = handleStreamEvent({ kind: "text_delta", blockKey: "three", text: "same" }, turn);
    const progress = handleStreamEvent({ kind: "thinking_complete", blockKey: "progress", thinking: "Checking.", presentation: "progress" }, turn);
    const privateDraft = handleStreamEvent({ kind: "thinking_delta", blockKey: "narration", text: "Done." }, turn);
    const narration = handleStreamEvent({ kind: "thinking_complete", blockKey: "narration", thinking: "Done.", signature: "Eg0KC0IJbmFycmF0aW9u" }, turn);
    const tool = handleStreamEvent({ kind: "tool_use", toolCall: { id: "read", name: "read", input: {} } }, turn);
    const afterTool = handleStreamEvent({ kind: "text_delta", blockKey: "four", text: "same" }, turn);
    // A thought streams under the coordinate it takes when it lands as the
    // next part, so the narration settles where its draft streamed.
    expect([preview, first, adjacent, reasoning, afterHidden, progress, privateDraft, narration, tool, afterTool].map(event => event.outputIdentity?.blockKey))
      .toEqual(["entry:0", "entry:0", "entry:0", "entry:2", "entry:3", "entry:4", "entry:5", "entry:5", "entry:6", "entry:7"]);
    expect(turn.assistantContent.map(part => part.type)).toEqual(["text", "text", "reasoning", "text", "thinking", "thinking", "tool_use", "text"]);
    const next = result();
    next.entryId = "next";
    expect(handleStreamEvent({ kind: "text_delta", blockKey: "one", text: "same" }, next).outputIdentity?.blockKey).toBe("next:0");
  });

  test("delta association work stays bounded as prior canonical content grows", () => {
    const measure = (priorParts: number) => {
      const turn = result();
      for (let index = 0; index < priorParts; index += 1) {
        handleStreamEvent(index % 2 === 0
          ? { kind: "text_delta", blockKey: `prior-${index}`, text: "prior" }
          : { kind: "reasoning", id: `hidden-${index}`, encryptedContent: "opaque", blockKey: `hidden-${index}` }, turn);
      }
      let accesses = 0;
      turn.assistantContent = new Proxy(turn.assistantContent, {
        get(target, property, receiver) {
          accesses += 1;
          // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: a Proxy trap forwards an arbitrary property key to its target
          return Reflect.get(target, property, receiver);
        },
      });
      const identities: (string | undefined)[] = [];
      for (let index = 0; index < 32; index += 1) {
        identities.push(handleStreamEvent({
          kind: "text_delta", blockKey: `part-${index}`, text: `${index},`,
        }, turn).outputIdentity?.blockKey);
      }
      const deltaAccesses = accesses;
      expect(identities).toEqual(Array.from({ length: 32 }, () => `entry:${priorParts}`));
      expect(turn.assistantContent.slice(priorParts)).toEqual(
        Array.from({ length: 32 }, (_, index) => ({ type: "text", text: `${index},` })),
      );
      return deltaAccesses;
    };
    const small = measure(4);
    const large = measure(400);
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
  });
});
