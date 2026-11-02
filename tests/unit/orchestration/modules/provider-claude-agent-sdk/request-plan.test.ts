import { describe, expect, test } from "bun:test";
import type { CliBlock, CliMessage, CliView, QueryIdentity } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js";
import { planRequest, type CliCopy, type HandlerDelivery, type QueryState } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/request-plan.js";

const IDENTITY: QueryIdentity = {
  systemPrompt: ["Flywheel prompt."], tools: [{ name: "read", description: "Reads.", inputSchema: { type: "object" } }],
  thinking: { type: "adaptive" }, toolChoice: undefined, maxTokens: 32_000, extraBody: {}, cwd: "/work", eagerInputStreaming: true,
  promptCaching: true, effort: "high",
};
const user = (...content: CliBlock[]): CliMessage => ({ role: "user", content });
const assistant = (...content: CliBlock[]): CliMessage => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value }) as const;
const call = (id: string): CliBlock => ({ type: "tool_use", id, name: "mcp__runtime__read", input: { path: id } });
const result = (id: string, content: Extract<CliBlock, { type: "tool_result" }>["content"] = [text(`out ${id}`)], isError?: true): CliBlock =>
  ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: isError } : {}) });

/** A PNG header of the given size, which is all that the CLI's limits read. */
function image(width: number, height: number): Extract<CliBlock, { type: "image" }> {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return { type: "image", source: { type: "base64", media_type: "image/png", data: header.toString("base64") } };
}

const U1 = user(text("Read a and b."));
const A1 = assistant(text("Reading."), call("t1"), call("t2"));

function view(messages: CliMessage[], overrides: Partial<CliView> = {}): CliView {
  return { messages, reminders: [], identity: IDENTITY, origins: messages.map((message) => message.content.map(() => message.role === "assistant" ? "assistant" : "person")), ...overrides };
}
const copy = (messages: CliMessage[], overrides: Partial<CliCopy> = {}): CliCopy => ({ identity: IDENTITY, messages, ...overrides });
const parked = (messages: CliMessage[], toolUseIds = ["t1", "t2"]): QueryState => ({ kind: "parked", copy: copy(messages), toolUseIds });
const HOSTED: HandlerDelivery = { results: "successes-and-errors", runtimeNotices: [] };

describe("the request plan", () => {
  test("delivers exactly the parked results through the handlers", () => {
    expect(planRequest(view([U1, A1, user(result("t1"), result("t2"))]), parked([U1, A1]))).toEqual({
      kind: "deliver", results: [{ toolUseId: "t1", content: [text("out t1")] }, { toolUseId: "t2", content: [text("out t2")] }],
    });
  });

  test("pushes the next user message into an idle query", () => {
    const answered = assistant(text("Done."));
    const next = user(text("Now c."));
    expect(planRequest(view([U1, answered, next]), { kind: "idle", copy: copy([U1, answered]) })).toEqual({ kind: "push", message: next });
  });

  test("starts a query with the history and its reminders, and pushes the tail as one message", () => {
    const reminder = { kind: "date", date: "2026-10-07", changed: false } as const;
    const tail = user(result("t1"), result("t2"), text("Also c."));
    const plan = planRequest(view([U1, A1, tail], { reminders: [{ message: 0, reminder }, { message: 2, reminder }] }), parked([U1, A1]));
    expect(plan).toEqual({ kind: "start", trigger: { kind: "results-with-input" }, history: [U1, A1], reminders: [{ message: 0, reminder }], message: tail, delivery: "push" });
    expect(planRequest(view([U1]), { kind: "released" })).toMatchObject({ kind: "start", trigger: { kind: "first-request" }, history: [] });
    expect(planRequest(view([U1, A1, tail]), { kind: "released" })).toMatchObject({ kind: "start", trigger: { kind: "released" }, history: [U1, A1] });
  });

  test("writes a tail with an image that the CLI would rewrite into the transcript with its reminders, and pushes an empty message", () => {
    const reminder = { kind: "date", date: "2026-10-08", changed: true } as const;
    const answered = assistant(text("Done."));
    const tail = user(text("See this."), image(3_000, 3_000));
    const idle: QueryState = { kind: "idle", copy: copy([U1, answered]) };
    expect(planRequest(view([U1, answered, tail], { reminders: [{ message: 2, reminder }] }), idle)).toEqual({
      kind: "start", trigger: { kind: "image-tail" }, history: [U1, answered, tail], reminders: [{ message: 2, reminder }], message: user(), delivery: "row",
    });
    expect(planRequest(view([tail]), { kind: "released" })).toEqual({ kind: "start", trigger: { kind: "first-request" }, history: [tail], reminders: [], message: user(), delivery: "row" });
    // The CLI keeps a small top-level image and every image inside a tool result, so those tails go by a push.
    expect(planRequest(view([U1, answered, user(text("See this."), image(800, 600))]), idle)).toMatchObject({ kind: "push" });
    expect(planRequest(view([U1, A1, user(result("t1", [image(3_000, 3_000)]), result("t2"))]), parked([U1, A1])))
      .toMatchObject({ kind: "start", trigger: { kind: "undeliverable-result" }, delivery: "push" });
  });

  test("names the reason for every new query", () => {
    const tail = user(result("t1"), result("t2"));
    const cases: [string, CliView, QueryState][] = [
      ["busy", view([U1, A1, tail]), { kind: "busy" }],
      ["poisoned", view([U1, A1, tail]), { kind: "poisoned" }],
      ["history", view([user(text("Read a, b.")), A1, tail]), parked([U1, A1])],
      ["history", view([U1, A1, tail]), { kind: "idle", copy: copy([U1, A1, tail, assistant(text("Done."))]) }],
      ["tail", view([U1, A1, tail, A1, tail]), parked([U1, A1])],
      ["result-ids", view([U1, A1, user(result("t2"), result("t1"))]), parked([U1, A1])],
      ["result-ids", view([U1, A1, user(result("t1"))]), parked([U1, A1])],
      ["undeliverable-result", view([U1, A1, user(result("t1"), result("t2", [text("failed")], true))]), parked([U1, A1])],
    ];
    for (const [trigger, request, state] of cases) expect(planRequest(request, state), trigger).toMatchObject({ kind: "start", trigger: { kind: trigger } });
    expect(planRequest(view([U1, A1, tail], { identity: { ...IDENTITY, systemPrompt: ["Other."] } }), parked([U1, A1])))
      .toMatchObject({ kind: "start", trigger: { kind: "identity", field: "systemPrompt" } });
    // On a per-turn-effort model the engine copies the effort of each earlier turn into the conversation, and native
    // copies only the request's effort, so every change of the level, its removal, and its return need a new query.
    const changes: [held: QueryIdentity["effort"], requested: QueryIdentity["effort"]][] = [["high", "low"], ["high", undefined], [undefined, "high"]];
    for (const [held, requested] of changes) {
      const state: QueryState = { kind: "idle", copy: copy([U1, A1, tail, assistant(text("Done."))], { identity: { ...IDENTITY, effort: held } }) };
      expect(planRequest(view([U1, A1, tail, assistant(text("Done.")), user(text("Next."))], { identity: { ...IDENTITY, effort: requested } }), state), `${held} to ${requested}`)
        .toMatchObject({ kind: "start", trigger: { kind: "identity", field: "effort" } });
    }
  });

  test("treats a held copy as a prefix without regard to key order", () => {
    const reordered = assistant(text("Reading."), { type: "tool_use", name: "mcp__runtime__read", input: { path: "t1" }, id: "t1" }, call("t2"));
    expect(planRequest(view([U1, reordered, user(result("t1"), result("t2"))]), parked([U1, A1])).kind).toBe("deliver");
  });

  test("delivers a result through a handler only when the handler keeps it intact, and names why it cannot", () => {
    const planned = (content: Extract<CliBlock, { type: "tool_result" }>["content"], isError?: true) => {
      const plan = planRequest(view([U1, A1, user(result("t1"), result("t2", content, isError))]), parked([U1, A1]));
      return plan.kind === "start" && plan.trigger.kind === "undeliverable-result" ? plan.trigger.result : plan.kind;
    };
    expect(planned([text("ok"), text("more")])).toBe("deliver");
    expect(planned([text("x".repeat(250_000)), text("y".repeat(250_000))])).toBe("deliver");
    expect(planned([text("x".repeat(500_001))])).toBe("over-limit");
    expect(planned([text("failed")], true)).toBe("error");
    expect(planned([])).toBe("empty");
    expect(planned([text("  \n")])).toBe("empty");
    expect(planned([text("see"), { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }])).toBe("image");
  });

  test("a shared agent host also delivers the results that the CLI rewrites by a fixed rule, and names each rewrite", () => {
    const delivered = (content: Extract<CliBlock, { type: "tool_result" }>["content"], isError?: true) =>
      planRequest(view([U1, A1, user(result("t1"), result("t2", content, isError))]), parked([U1, A1]), HOSTED);
    const rewriteOf = (plan: ReturnType<typeof delivered>) => plan.kind === "deliver" ? plan.results.at(-1)?.rewrite : plan.kind === "start" && plan.trigger.kind === "undeliverable-result" ? plan.trigger.result : plan.kind;
    expect(delivered([text("failed")], true)).toEqual({ kind: "deliver", results: [{ toolUseId: "t1", content: [text("out t1")] }, { toolUseId: "t2", content: [text("failed")], isError: true }] });
    expect(rewriteOf(delivered([text("x".repeat(10_000))], true))).toBeUndefined();
    // The CLI writes its own text for a blank success, and joins and trims an error's text blocks.
    expect(delivered([])).toEqual({ kind: "deliver", results: [{ toolUseId: "t1", content: [text("out t1")] }, { toolUseId: "t2", content: [], rewrite: "no-output" }] });
    expect(rewriteOf(delivered([text("  \n")]))).toBe("no-output");
    expect(rewriteOf(delivered([text("failed\n")], true))).toBe("error-joined");
    expect(rewriteOf(delivered([text("one"), text("two")], true))).toBe("error-joined");
    // The CLI cuts an error over 10,000 characters, and a partly blank result is no fixed rewrite.
    expect(rewriteOf(delivered([text("x".repeat(10_001))], true))).toBe("error-over-limit");
    expect(rewriteOf(delivered([text("x".repeat(5_000)), text("y".repeat(5_000))], true))).toBe("error-over-limit");
    expect(rewriteOf(delivered([text("see"), text(" ")]))).toBe("empty");
  });

  test("a shared agent host folds a tail of only runtime notices into the last result, and starts the query when that result cannot carry them", () => {
    const notice = "<subagent_notifications>child done</subagent_notifications>";
    const expiry = "<wait_expired>240</wait_expired>";
    const fold = (tail: CliBlock[], runtimeNotices: string[], last: CliBlock = result("t2")) =>
      planRequest(view([U1, A1, user(result("t1"), last, ...tail)]), parked([U1, A1]), { ...HOSTED, runtimeNotices });
    const reason = (plan: ReturnType<typeof fold>) => plan.kind === "start" ? (plan.trigger.kind === "notice-carrier" ? plan.trigger.reason : plan.trigger.kind) : plan.kind;
    // The notices follow the last result's own text, in the tail's order, and the earlier result passes unchanged.
    expect(fold([text(expiry), text(notice)], [notice, expiry])).toEqual({ kind: "deliver", results: [
      { toolUseId: "t1", content: [text("out t1")] },
      { toolUseId: "t2", content: [text("out t2"), text(expiry), text(notice)], rewrite: "notice-folded" },
    ] });
    // An earlier failed result passes as before.
    expect(planRequest(view([U1, A1, user(result("t1", [text("failed")], true), result("t2"), text(notice))]), parked([U1, A1]), { ...HOSTED, runtimeNotices: [notice] }))
      .toMatchObject({ kind: "deliver", results: [{ isError: true }, { rewrite: "notice-folded" }] });
    // The chat's query takes no notice, and an input that is more than the notices starts the query.
    expect(planRequest(view([U1, A1, user(result("t1"), result("t2"), text(notice))]), parked([U1, A1])).kind).toBe("start");
    expect(reason(fold([text(notice), text("A person's words.")], [notice]))).toBe("results-with-input");
    expect(reason(fold([text(notice), text(notice)], [notice]))).toBe("results-with-input");
    expect(reason(fold([text(notice)], []))).toBe("results-with-input");
    expect(reason(planRequest(view([U1, A1, user(text(notice))]), parked([U1, A1]), { ...HOSTED, runtimeNotices: [notice] }))).toBe("results-with-input");
    // A failed, blank, or full last result carries no notice.
    expect(reason(fold([text(notice)], [notice], result("t2", [text("failed")], true)))).toBe("error");
    expect(reason(fold([text(notice)], [notice], result("t2", [])))).toBe("rewrite");
    expect(reason(fold([text(notice)], [notice], result("t2", [text("x".repeat(499_990))])))).toBe("over-limit");
    expect(reason(fold([text("  ")], ["  "]))).toBe("empty");
  });

  test("refuses a request without a final user message", () => {
    expect(planRequest(view([]), { kind: "released" })).toEqual({ kind: "refuse", issue: "the request holds no message" });
    expect(planRequest(view([U1, A1]), { kind: "released" }).kind).toBe("refuse");
  });
});
