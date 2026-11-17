import { z } from "zod";

/** One request that reached the mock, as the decision backend switch tests read it. */
export interface DecisionRequestRecord {
  readonly path: string;
  readonly model: string;
  readonly bearer: boolean;
  readonly questions: number;
}

export interface MockDecisionModels {
  /** The server origin, such as `http://127.0.0.1:43210`, without an API version path. */
  readonly origin: string;
  readonly requests: readonly DecisionRequestRecord[];
  /** The character length of each request body, in arrival order. */
  readonly bodyChars: readonly number[];
  /** Requests whose answer is still pending: neither sent nor abandoned by the client. */
  readonly pending: number;
  /** The yes-probability that every later boolean question gets. */
  answerWith(probability: number): void;
  /** How long every later answer waits before it is sent. */
  delayAnswers(ms: number): void;
  stop(): void;
}

const typeSafeQuestion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul") }),
  z.object({ type: z.literal("choice"), criteria: z.record(z.string(), z.string().nullable()) }),
]);

const typeSafeBody = z.object({
  model: z.string(),
  questions: z.record(z.string(), typeSafeQuestion),
});

const openAiBody = z.object({
  model: z.string(),
  questions: z.array(z.object({ type: z.literal("predicate"), name: z.string() })),
});

function typeSafeAnswer(question: z.infer<typeof typeSafeQuestion>, probability: number) {
  if (question.type === "noul") return { type: "noul", noul: probability };
  // A location question picks its first line or range of lines.
  const choice = Object.keys(question.criteria).find((key) => key !== "unknown") ?? "unknown";
  return { type: "choice", choice, probabilities: { [choice]: probability } };
}

/**
 * A local stand-in for both decision APIs, in the request and response shapes that
 * `@ai-sdk/typesafe-ai` and `@ai-sdk/openai` use: TypeSafe's `POST /v1/systemone` and OpenAI's
 * `POST /v1/decisions`. TypeSafe gets boolean and choice answers; OpenAI gets boolean answers
 * only, which is all the anti-slop rules without a `location` question ask. The caller must not
 * block its own event loop while a client waits for an answer.
 */
export function startMockDecisionModels(): MockDecisionModels {
  const requests: DecisionRequestRecord[] = [];
  const bodyChars: number[] = [];
  let probability = 0.9;
  let delayMs = 0;
  let pending = 0;
  const answer = (path: string, bearer: boolean, json: unknown): Response => {
    if (path === "/v1/systemone") {
      const body = typeSafeBody.parse(json);
      const entries = Object.entries(body.questions);
      requests.push({ path, model: body.model, bearer, questions: entries.length });
      const answers = Object.fromEntries(entries.map(([id, question]) => [id, typeSafeAnswer(question, probability)]));
      return Response.json({ model: "jev-mock", answers, usage: { input_tokens: 1, output_tokens: 0 } });
    }
    if (path === "/v1/decisions") {
      const body = openAiBody.parse(json);
      requests.push({ path, model: body.model, bearer, questions: body.questions.length });
      return Response.json({
        model: `${body.model}-mock`,
        answers: body.questions.map((question) => ({ type: "predicate", name: question.name, probability })),
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const bearer = request.headers.get("authorization")?.startsWith("Bearer ") === true;
      const text = await request.text();
      bodyChars.push(text.length);
      const reply = answer(path, bearer, JSON.parse(text));
      pending += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        request.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      pending -= 1;
      return reply;
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    bodyChars,
    get pending() {
      return pending;
    },
    answerWith(next) {
      probability = next;
    },
    delayAnswers(ms) {
      delayMs = ms;
    },
    stop() {
      void server.stop(true);
    },
  };
}
