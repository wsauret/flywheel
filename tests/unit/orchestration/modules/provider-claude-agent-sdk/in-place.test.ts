import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Exit } from "effect";
import type { CliBlock, CliMessage, CliView, PlacedReminder, QueryIdentity } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js";
import type { ClaudeReminder } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import { createReplayAcks, planReload, replayFrames, type HeldConversation, type OpeningStatement, type ReloadDecision } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/in-place.js";
import { planRequest, type CliCopy, type QueryState } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/request-plan.js";

const IDENTITY: QueryIdentity = {
  systemPrompt: ["Stable tier.", "Session tier."], tools: [{ name: "read", description: "Reads.", inputSchema: { type: "object" } }],
  thinking: { type: "adaptive" }, toolChoice: undefined, maxTokens: 32_000, extraBody: {}, cwd: "/work", eagerInputStreaming: true,
  promptCaching: true, effort: "high",
};
const user = (...content: CliBlock[]): CliMessage => ({ role: "user", content });
const assistant = (...content: CliBlock[]): CliMessage => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value }) as const;
const call = (id: string): CliBlock => ({ type: "tool_use", id, name: "mcp__runtime__read", input: { path: id } });
const result = (id: string, isError?: true): CliBlock => ({ type: "tool_result", tool_use_id: id, content: [text(`out ${id}`)], ...(isError ? { is_error: isError } : {}) });
const environment: PlacedReminder = { message: 0, reminder: { kind: "date", date: "2026-10-08", changed: false } };
const TODAY = "2026-10-14";
type Environment = Extract<ClaudeReminder, { kind: "environment" }>;
const MACOS: Environment = { kind: "environment", workingDirectory: "/work", isWorktree: false, isGitRepo: true, platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0" };
const LINUX: Environment = { ...MACOS, platform: "linux", shell: "bash", osVersion: "Linux 6.8.0-45-generic" };
const WINDOWS: Environment = { ...MACOS, workingDirectory: "C:\\work", platform: "win32", shell: "PowerShell", osVersion: "Windows 11 Pro 10.0.26100" };
/** What the engine states now at an opening turn: today's date and the canonical environment `stated`. */
const statement = (stated: Environment = MACOS): OpeningStatement => ({ today: TODAY, environment: () => stated });
/** The reminders that the first request of a conversation holds on its first message, as the CLI states them itself. */
const opening = (date = TODAY, message = 0, stated: Environment = MACOS): PlacedReminder[] => [
  { message, reminder: stated },
  { message, reminder: { kind: "model", text: "The model reminder.", modelId: "claude-sonnet-5-5" } },
  { message, reminder: { kind: "date", date, changed: false } },
];

/** A PNG header above the CLI's 2,000-pixel limit, which is all that its limits read. */
function largeImage(): Extract<CliBlock, { type: "image" }> {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(3_000, 16);
  header.writeUInt32BE(3_000, 20);
  return { type: "image", source: { type: "base64", media_type: "image/png", data: header.toString("base64") } };
}

// Turn 0 holds the environment reminder; turns 1 and 2 hold none. The user rows of turns are rows the bridge wrote.
const U0 = user(text("Read a."));
const A0 = assistant(text("Reading."), call("t1"));
const R0 = user(result("t1"));
const B0 = assistant(text("Done."));
const U1 = user(text("Now b."));
const A1 = assistant(text("B is done."));
const U2 = user(text("Now c."));
const HISTORY = [U0, A0, R0, B0, U1, A1];
const ROWS = new Map([[0, "row-0"], [4, "row-4"]]);

function view(messages: CliMessage[], overrides: Partial<CliView> = {}): CliView {
  return { messages, reminders: [environment], identity: IDENTITY, origins: messages.map((message) => message.content.map(() => message.role === "assistant" ? "assistant" : "person")), ...overrides };
}
/** A live query as both planners read it: the request planner's copy and the reload planner's conversation. */
function held(overrides: Partial<HeldConversation & CliCopy> = {}): HeldConversation & CliCopy {
  return { identity: IDENTITY, messages: HISTORY, rows: ROWS, exact: true, ...overrides };
}
/** The reload decision for a request against a live query, through the request planner's start plan. */
function decide(request: CliView, copy: HeldConversation & CliCopy, state: "idle" | "parked" | "poisoned" = "idle", now: OpeningStatement = statement()) {
  const queryState: QueryState = state === "poisoned" ? { kind: "poisoned" }
    : state === "parked" ? { kind: "parked", copy, toolUseIds: ["t9"] } : { kind: "idle", copy };
  const plan = planRequest(request, queryState);
  if (plan.kind !== "start") throw new Error(`the request plan is ${plan.kind}`);
  return planReload(copy, request, plan, now);
}

describe("the in-place rotation plan", () => {
  test("a new untiered system prompt on an exact idle copy is set in place, and the tail is pushed with nothing replayed or cut", () => {
    const prompt = { ...IDENTITY, systemPrompt: ["One prompt."] };
    expect(decide(view([...HISTORY, U2], { identity: prompt }), held())).toEqual({ kind: "reload", systemPrompt: "One prompt.", cut: undefined, from: 6, replay: [], opening: false });
    expect(decide(view([...HISTORY, U2], { identity: { ...IDENTITY, systemPrompt: ["Stable tier.", "Another session tier."] } }), held())).toEqual({ kind: "cold", reason: "system-tiers" });
    expect(decide(view([...HISTORY, U2], { identity: { ...IDENTITY, systemPrompt: [] } }), held())).toEqual({ kind: "cold", reason: "system-tiers" });
    // The CLI splits a set_model text at the boundary marker on its own line and keeps the newline in both blocks, so
    // a text with the marker never goes in place.
    const marked = { ...IDENTITY, systemPrompt: [`Stable tier.\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\nSession tier.`] };
    expect(decide(view([...HISTORY, U2], { identity: marked }), held())).toEqual({ kind: "cold", reason: "system-tiers" });
  });

  test("a launch value other than the prompt, such as a removed effort, or a trigger without a reloadable copy starts a new process", () => {
    expect(decide(view([...HISTORY, U2], { identity: { ...IDENTITY, tools: [] } }), held())).toEqual({ kind: "cold", reason: "identity" });
    expect(decide(view([...HISTORY, U2], { identity: { ...IDENTITY, systemPrompt: ["One prompt."], maxTokens: 1 } }), held())).toEqual({ kind: "cold", reason: "identity" });
    expect(decide(view([...HISTORY, U2], { identity: { ...IDENTITY, effort: undefined } }), held())).toEqual({ kind: "cold", reason: "identity" });
    expect(decide(view([...HISTORY, U2], { identity: { ...IDENTITY, systemPrompt: ["One prompt."], promptCaching: false } }), held())).toEqual({ kind: "cold", reason: "identity" });
    const busy = planRequest(view([...HISTORY, U2]), { kind: "busy" });
    if (busy.kind !== "start") throw new Error("a busy query starts a new one");
    expect(planReload(held(), view([...HISTORY, U2]), busy, statement())).toEqual({ kind: "cold", reason: "trigger" });
  });

  test("a changed answer cuts the CLI's copy at the turn's first user row and replays the turn up to the tail", () => {
    const edited = assistant(text("B is done, edited."));
    expect(decide(view([...HISTORY.slice(0, 5), edited, U2]), held())).toEqual({
      kind: "reload", systemPrompt: undefined, cut: { row: "row-4", lastSeen: "row-4" }, from: 4, replay: [U1, edited], opening: false,
    });
  });

  test("an idle copy that the request extends by more than one message takes the new rows after it without a cut", () => {
    const answer = assistant(text("Another answer."));
    expect(decide(view([...HISTORY, U2, answer, user(text("And d."))]), held())).toEqual({ kind: "reload", systemPrompt: undefined, cut: undefined, from: 6, replay: [U2, answer], opening: false });
  });

  test("a parked or diverged copy is cut at its last turn start even when the request only adds to it, which removes what the CLI added", () => {
    const parkedCopy = held({ messages: [...HISTORY, U2, assistant(call("t9"))], rows: new Map([...ROWS, [6, "row-6"]]), exact: false });
    const failed = user(result("t9", true));
    expect(decide(view([...parkedCopy.messages, failed]), parkedCopy, "parked")).toEqual({
      kind: "reload", systemPrompt: undefined, cut: { row: "row-6", lastSeen: "row-6" }, from: 6, replay: [U2, assistant(call("t9"))], opening: false,
    });
    expect(decide(view([...HISTORY, U2]), held({ exact: false }), "poisoned")).toMatchObject({ kind: "reload", cut: { row: "row-4" }, from: 4, replay: [U1, A1] });
  });

  test("a cut that would replay a reminder, an image the CLI rewrites, or a row the bridge did not write starts a new process", () => {
    const edited = assistant(text("Reading again."), call("t1"));
    expect(decide(view([U0, edited, R0, B0, U1, A1, U2]), held())).toEqual({ kind: "cold", reason: "replayed-reminder" });
    const pictured = user(text("Now b."), largeImage());
    const withImage = held({ messages: [...HISTORY.slice(0, 4), pictured, A1] });
    expect(decide(view([...HISTORY.slice(0, 4), pictured, assistant(text("Edited.")), U2]), withImage)).toEqual({ kind: "cold", reason: "replayed-image" });
    expect(decide(view([...HISTORY.slice(0, 5), assistant(text("Edited.")), U2]), held({ rows: new Map() }))).toEqual({ kind: "cold", reason: "no-row" });
  });

  test("a cut at the opening row replays it as a turn start when it holds only today's opening reminders, which the CLI states itself", () => {
    // A step's first rotation: the parked copy's only turn start is the opening row, which holds the reminders.
    const parkedCopy = held({ messages: [U0, A0], rows: new Map([[0, "row-0"]]), exact: false });
    const failed = user(result("t1", true));
    expect(decide(view([U0, A0, failed], { reminders: opening() }), parkedCopy, "parked")).toEqual({
      kind: "reload", systemPrompt: undefined, cut: { row: "row-0", lastSeen: "row-0" }, from: 0, replay: [U0, A0], opening: true,
    });
    // On another day the CLI would state another date than the history's, as it would beside a reminder of a later
    // message, so both go cold.
    expect(decide(view([U0, A0, failed], { reminders: opening("2026-10-13") }), parkedCopy, "parked")).toEqual({ kind: "cold", reason: "replayed-reminder" });
    const update: PlacedReminder = { message: 2, reminder: { kind: "date", date: TODAY, changed: true } };
    const later = held({ messages: [U0, A0, R0, assistant(call("t2"))], rows: new Map([[0, "row-0"]]), exact: false });
    expect(decide(view([U0, A0, R0, assistant(call("t2")), user(result("t2", true))], { reminders: [...opening(), update] }), later, "parked")).toEqual({ kind: "cold", reason: "replayed-reminder" });
    // A partial set is not what the CLI states at an opening turn.
    expect(decide(view([U0, A0, failed], { reminders: opening().slice(0, 2) }), parkedCopy, "parked")).toEqual({ kind: "cold", reason: "replayed-reminder" });
  });

  test("an opening replay needs the canonical environment now to equal the row's on every platform: a changed git state or another shell go cold", () => {
    const parkedCopy = held({ messages: [U0, A0], rows: new Map([[0, "row-0"]]), exact: false });
    const failed = user(result("t1", true));
    const reload: ReloadDecision = { kind: "reload", systemPrompt: undefined, cut: { row: "row-0", lastSeen: "row-0" }, from: 0, replay: [U0, A0], opening: true };
    const cold: ReloadDecision = { kind: "cold", reason: "replayed-reminder" };
    const rotate = (canonical: Environment, now: Environment, cwd = canonical.workingDirectory) =>
      decide(view([U0, A0, failed], { reminders: opening(TODAY, 0, canonical), identity: { ...IDENTITY, cwd } }), held({ ...parkedCopy, identity: { ...IDENTITY, cwd } }), "parked", statement(now));
    // A transcript and the engine state the canonical facts with the engine's shell, so the replayed opening turn
    // gives the request of a cold rotation, also on Windows, where the engine can name bash for PowerShell.
    expect(rotate(MACOS, MACOS)).toEqual(reload);
    expect(rotate(LINUX, LINUX)).toEqual(reload);
    expect(rotate(WINDOWS, WINDOWS)).toEqual(reload);
    // A git state that changed since the conversation opened, and a shell that the engine reads otherwise, would make
    // the engine state another environment than the transcript.
    expect(rotate(MACOS, { ...MACOS, isGitRepo: false })).toEqual(cold);
    expect(rotate(MACOS, { ...MACOS, isWorktree: true })).toEqual(cold);
    expect(rotate(LINUX, { ...LINUX, shell: "zsh" })).toEqual(cold);
  });

  test("a tail that must be the last transcript row starts a new process", () => {
    expect(decide(view([...HISTORY.slice(0, 5), assistant(text("Edited.")), user(text("Look."), largeImage())]), held())).toEqual({ kind: "cold", reason: "row-delivery" });
  });
});

describe("the replay frames", () => {
  test("user rows keep the transcript's key order and add no model request, and a thinking-only answer gets the transcript's carrier", () => {
    const thinking = assistant({ type: "thinking", thinking: "Hmm.", signature: "sig" });
    const ids = ["id-a", "id-b", "id-c"];
    const frames = replayFrames({ kind: "reload", systemPrompt: undefined, cut: undefined, from: 2, replay: [user(result("t1", true)), thinking, user(text("Go."))], opening: false }, "claude-sonnet-5-5", () => ids.shift() ?? "");

    expect(frames.map((frame) => JSON.stringify(frame))).toEqual([
      JSON.stringify({ type: "user", uuid: "id-a", shouldQuery: false, parent_tool_use_id: null, message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result", content: [text("out t1")], is_error: true }] } }),
      JSON.stringify({ type: "assistant", uuid: "id-b", session_id: "", parent_tool_use_id: null, message: {
        id: "msg_rotation_3", type: "message", role: "assistant", model: "claude-sonnet-5-5",
        content: [{ type: "thinking", thinking: "Hmm.", signature: "sig" }, { type: "server_tool_use", id: "srvtoolu_rotation_carrier_3", name: "code_execution", input: {} }],
        stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      } }),
      JSON.stringify({ type: "user", uuid: "id-c", shouldQuery: false, parent_tool_use_id: null, message: { role: "user", content: [text("Go.")] } }),
    ]);
  });
  test("the opening row of an opening replay is a turn start, and every other row joins without a model request", () => {
    const ids = ["id-a", "id-b"];
    const frames = replayFrames({ kind: "reload", systemPrompt: undefined, cut: { row: "row-0", lastSeen: "row-0" }, from: 0, replay: [U0, A0], opening: true }, "claude-sonnet-5-5", () => ids.shift() ?? "");
    expect(frames[0]).toEqual({ type: "user", uuid: "id-a", parent_tool_use_id: null, message: { role: "user", content: [text("Read a.")] } });
    expect(frames[1]).toMatchObject({ type: "assistant", uuid: "id-b" });
  });
});

describe("the replay answers", () => {
  test("an answer that names a replayed row settles its wait once, any other result passes on, and a stream end fails what still waits", async () => {
    const acks = createReplayAcks();
    const first = acks.expect("row-1");
    const second = acks.expect("row-2");

    expect([acks.settle("row-1"), acks.settle("row-1"), acks.settle("pushed-row"), acks.settle(undefined)]).toEqual([true, false, false, false]);
    expect(Exit.isSuccess(await Effect.runPromiseExit(first))).toBe(true);
    acks.end();
    expect(Exit.isFailure(await Effect.runPromiseExit(second))).toBe(true);
  });
});
