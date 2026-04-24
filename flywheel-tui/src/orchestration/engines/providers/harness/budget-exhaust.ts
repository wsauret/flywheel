// Final-turn handler for budget exhaustion. The loop hits maxLLMCalls, injects
// a "summarize remaining work" instruction, and makes one last tool-less call
// so the model can emit a closing message to the user.

import type { ContentBlock, LLMClient, Message, ReasoningEffort, StreamEvent } from "./llm/types.js";
import { appendTextBlock } from "./agent-state.js";

export interface BudgetExhaustInput {
  client: LLMClient;
  messages: ReadonlyArray<Message>;
  systemPrompt: string;
  reasoningEffort: ReasoningEffort | undefined;
  signal: AbortSignal | undefined;
  previousResponseId: string | undefined;
  onEvent: (event: StreamEvent) => void;
}

export interface BudgetExhaustOutcome {
  finalContent: ContentBlock[];
  previousResponseId: string | undefined;
}

export async function runBudgetExhaustTurn(input: BudgetExhaustInput): Promise<BudgetExhaustOutcome> {
  const finalStream = input.client.streamWithTools({
    messages: [...input.messages],
    tools: [],
    systemPrompt: input.systemPrompt,
    reasoningEffort: input.reasoningEffort,
    signal: input.signal,
    previousResponseId: input.previousResponseId,
  });

  const finalContent: ContentBlock[] = [];
  let nextResponseId = input.previousResponseId;
  for await (const event of finalStream) {
    input.onEvent(event);
    if (event.kind === "text_delta") appendTextBlock(finalContent, event.text);
    if (event.kind === "done" && event.responseId) nextResponseId = event.responseId;
  }
  return { finalContent, previousResponseId: nextResponseId };
}
