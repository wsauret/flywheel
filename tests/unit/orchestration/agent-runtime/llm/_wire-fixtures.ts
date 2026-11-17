import OpenAI from "openai";
import { z } from "zod";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

interface WireFrame { [key: string]: unknown }
const OriginalOpenAI = OpenAI;

/** Creates a real SDK client over an in-memory SSE response, including a terminal wire read failure when supplied. */
export function wireClient(frames: readonly WireFrame[], onRequest?: (body: WireFrame) => void, failure?: Error): OpenAI {
  return new OriginalOpenAI({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      onRequest?.(z.record(z.string(), z.unknown()).parse(await request.json()));
      return wireResponse(frames, failure);
    },
  });
}

export function wireResponse(frames: readonly WireFrame[], failure?: Error): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index++];
      if (frame) controller.enqueue(new TextEncoder().encode(`${typeof frame.type === "string" ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`));
      else if (failure) controller.error(failure);
      else controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** The body that the chat-completions adapter of `accessProvider` sends for one request of `options` to `model`, served
 *  under `wireModelId` when the provider names the model another way. */
export async function chatCompletionsRequestBody(input: {
  readonly accessProvider: AccessProviderId;
  readonly model: string;
  readonly wireModelId?: string;
  readonly info: ModelInfo;
  readonly options: StreamOptions;
}): Promise<WireFrame> {
  const bodies: WireFrame[] = [];
  const finish = { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  const adapter = await createOpenAIChatCompletionsAdapter(wireClient([finish], (body) => { bodies.push(body); }), input.model, input.info, {
    accessProvider: input.accessProvider, ...(input.wireModelId === undefined ? {} : { wireModelId: input.wireModelId }),
  });
  for await (const _event of adapter.streamWithTools(input.options)) { /* drain */ }
  const [body, ...others] = bodies;
  if (body === undefined || others.length > 0) throw new Error(`The adapter sent ${bodies.length} requests, not one`);
  return body;
}
