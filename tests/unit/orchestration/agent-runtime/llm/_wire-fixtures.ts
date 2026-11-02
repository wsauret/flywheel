import OpenAI from "openai";
import { z } from "zod";

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
