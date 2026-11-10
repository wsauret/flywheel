import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Clock, Effect, Exit, Queue, type Scope } from "effect";
import { DebugLog } from "../../../infra/debug-log.js";
import { asRecord } from "../../../infra/record.js";
import { createReplayAcks } from "./in-place.js";
import type { CliFrame, LaunchedQuery, QueryLaunch, QueryLauncherConfig } from "./query-launcher.js";
import { queueIterable } from "./queue-iterable.js";
import { readSdkMessages } from "./sdk-events.js";
import { bridgeSessionId } from "./session-id.js";
import { createStepGate } from "./step-gate.js";
import { createToolGate } from "./tool-gate.js";
import { cliAssistantMessage } from "./transcript.js";

/**
 * The CLI versions on which the in-place rotation reproduced a cold rotation's request on the fake host. The CLI's
 * protocol marks `set_model.system_prompt` internal, and neither `rewind_conversation` nor input frames are in the SDK's
 * declared types: a CLI without one of them acknowledges the request and does nothing. A version joins this list
 * only after the fake-host proof of every trigger, and each process still runs the self-test once per version and model.
 */
const IN_PLACE_CLI_VERSIONS: ReadonlySet<string> = new Set(["2.1.293", "2.1.294", "2.1.295", "2.1.296", "2.1.306", "2.1.321"]);

/** The longest self-test. A CLI start takes about 300 ms, and two requests to the local host take a few more. */
const SELF_TEST_BOUND_MS = 30_000;
/** How long a version stays cold after a self-test that proved nothing, such as one that timed out under load. */
const INCONCLUSIVE_RETRY_MS = 10 * 60_000;
const DUMMY_KEY = "sk-ant-api03-in-place-self-test";

/** Whether a live query on this CLI version may rotate in place. */
type InPlaceStatus = "ready" | "checking" | "unlisted" | "failed";

export interface InPlaceGate {
  /** The status for the version. The first ask for a listed version forks its self-test into the caller's scope,
   *  which stops the test when it closes, and the answer is `checking` until the test ends. */
  status(cliVersion: string): Effect.Effect<InPlaceStatus, never, Scope.Scope>;
}

/** How a self-test ended. A conclusive failure is the CLI's own answer, which a later test repeats; an inconclusive
 *  one, such as a timeout or a launch error, proves nothing about the CLI. */
export type SelfTestResult = { readonly passed: true } | { readonly passed: false; readonly failure: string; readonly conclusive: boolean };

type CheckState =
  | { readonly kind: "checking" | "unlisted" | "passed" | "failed" }
  /** A failed test that proved nothing. The version stays cold until `retryAtMs`, when the next ask tests again. */
  | { readonly kind: "inconclusive"; readonly retryAtMs: number };

/** The state of each version and model that this process asked about. The self-test proves a CLI binary with one
 *  model, which every bridge of the process with that model shares, so one test per version and model serves them all. */
type CheckStates = Map<string, CheckState>;
const processChecks: CheckStates = new Map();

/**
 * The gate over the allowlist and the self-test, for one model as the CLI names it (the model id and its window).
 * Each decision for a version and model is recorded once (`provider.claude_sdk.in_place.checked`): an unlisted
 * version, or the end of its self-test.
 */
export function inPlaceGate(runSelfTest: (cliVersion: string) => Effect.Effect<SelfTestResult>, model: string, checks: CheckStates = processChecks): InPlaceGate {
  const record = (cliVersion: string, outcome: string, details: { readonly durationMs?: number; readonly failure?: string } = {}) =>
    DebugLog.record({ type: "provider.claude_sdk.in_place.checked", payload: { cliVersion, model, outcome, ...details } });
  return {
    status: (cliVersion) => Effect.gen(function* () {
      const key = `${cliVersion} ${model}`;
      const now = yield* Clock.currentTimeMillis;
      const known = checks.get(key);
      if (known !== undefined && !(known.kind === "inconclusive" && now >= known.retryAtMs)) return statusOf(known);
      if (!IN_PLACE_CLI_VERSIONS.has(cliVersion)) {
        checks.set(key, { kind: "unlisted" });
        record(cliVersion, "unlisted");
        return "unlisted";
      }
      checks.set(key, { kind: "checking" });
      const settle = (exit: Exit.Exit<SelfTestResult>) => Effect.gen(function* () {
        const durationMs = (yield* Clock.currentTimeMillis) - now;
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
          // The owner closed during the test, which proves nothing about the CLI, so the next ask tests again at once.
          checks.delete(key);
          return record(cliVersion, "interrupted", { durationMs });
        }
        const result = Exit.isSuccess(exit) ? exit.value : inconclusive("defect");
        if (result.passed) checks.set(key, { kind: "passed" });
        else checks.set(key, result.conclusive ? { kind: "failed" } : { kind: "inconclusive", retryAtMs: now + durationMs + INCONCLUSIVE_RETRY_MS });
        record(cliVersion, result.passed ? "passed" : result.conclusive ? "failed" : "inconclusive", { durationMs, ...(result.passed ? {} : { failure: result.failure }) });
      });
      yield* Effect.forkScoped(runSelfTest(cliVersion).pipe(Effect.onExit(settle)));
      return "checking";
    }),
  };
}

function statusOf(state: CheckState): InPlaceStatus {
  switch (state.kind) {
    case "passed": return "ready";
    case "checking": return "checking";
    case "unlisted": return "unlisted";
    case "failed":
    case "inconclusive": return "failed";
  }
}

/** What the self-test reproduces: the bridge's launch for its model, on a scratch login that only a local host serves. */
export interface SelfTestConfig {
  readonly launcher: QueryLauncherConfig;
  readonly launchQuery: (config: QueryLauncherConfig) => (launch: QueryLaunch) => LaunchedQuery;
  readonly wireModelId: string;
  readonly contextLimit: number;
}

/** A self-test that proves nothing about the CLI, named by its kind only. */
const inconclusive = (failure: string): SelfTestResult => ({ passed: false, failure, conclusive: false });

/**
 * The fake-host self-test of one CLI version. It starts the engine against a host on 127.0.0.1 with a dummy key
 * and a scratch config directory, so it reads no login and sends nothing off the machine. The test asks one request,
 * replaces the system prompt, and cuts the conversation before its first row. It replays that row as a turn start whose
 * step the gate refuses, as the bridge replays an opening row, then an answer, a row that joins without a turn, and
 * another answer, and asks a second request. It passes when the CLI sent exactly the two requests, the second carries
 * the new prompt and the five messages, the CLI's own system messages keep the place that they had in the first
 * request, and each replayed row's answer names the row. The scratch directory, the host, and the CLI are released
 * when the test ends, fails, or is interrupted.
 */
export function runInPlaceSelfTest(config: SelfTestConfig, cliVersion: string): Effect.Effect<SelfTestResult> {
  return Effect.scoped(Effect.gen(function* () {
    const scratch = yield* Effect.acquireRelease(
      Effect.try({ try: () => realpathSync(mkdtempSync(join(tmpdir(), "sdk-in-place-"))), catch: asError }),
      (directory) => Effect.sync(() => { rmSync(directory, { recursive: true, force: true }); }),
    );
    const host = yield* Effect.acquireRelease(Effect.try({ try: selfTestHost, catch: asError }), (served) => Effect.sync(() => { served.stop(); }));
    yield* Effect.try({ try: () => { for (const name of ["home", "config", "work"]) mkdirSync(join(scratch, name)); }, catch: asError });
    const launch = yield* Effect.try({ try: () => config.launchQuery({
      ...config.launcher, configDir: join(scratch, "config"), account: { home: join(scratch, "home"), user: config.launcher.account.user },
      cliEnvironment: { ANTHROPIC_BASE_URL: host.url, ANTHROPIC_API_KEY: DUMMY_KEY },
    }), catch: asError });
    return yield* selfTest(launch, config, cliVersion, host, join(scratch, "work"));
  })).pipe(
    Effect.timeoutOrElse({ duration: SELF_TEST_BOUND_MS, orElse: () => Effect.succeed(inconclusive("timeout")) }),
    Effect.catch((error: Error) => Effect.succeed(inconclusive(error.name))),
  );
}

function selfTest(launch: (launch: QueryLaunch) => LaunchedQuery, config: SelfTestConfig, cliVersion: string, host: SelfTestHost, cwd: string) {
  return Effect.gen(function* () {
    const prompt = yield* Queue.unbounded<CliFrame, Error | Cause.Done>();
    const write = (frame: CliFrame) => { Queue.offerUnsafe(prompt, frame); };
    const stepGate = createStepGate(() => {});
    const tool = { name: "check", description: "Checks.", inputSchema: { type: "object", properties: {} } };
    const toolGate = createToolGate([tool]);
    // Every turn result answers a frame the test wrote and waits for, so the replay acknowledgements read them all.
    const acks = createReplayAcks();
    const versions: string[] = [];
    const acquire = Effect.try({ try: () => {
      const launched = launch({
        prompt: queueIterable(prompt), systemPrompt: ["Self-test prompt one."], mcpServer: toolGate.server, stepGate, tools: [tool], cwd,
        session: { kind: "fresh", id: bridgeSessionId() }, wireModelId: config.wireModelId, contextLimit: config.contextLimit,
        thinking: { type: "disabled" }, extraBody: { max_tokens: 1_000 }, eagerInputStreaming: true, promptCaching: true, onStderrLine: () => {},
      });
      const reader = Effect.runPromise(readSdkMessages(launched.query, acks, (input) => {
        if (input.kind === "init") versions.push(input.cliVersion);
      }));
      return { launched, reader };
    }, catch: asError });
    /** Writes one frame and waits for the turn result that names it. */
    const answered = (frame: Extract<CliFrame, { type: "user" }>) => Effect.gen(function* () {
      const answer = acks.expect(frame.uuid);
      write(frame);
      yield* answer;
    });
    const use = ({ launched }: { readonly launched: LaunchedQuery }) => Effect.gen(function* () {
      const first = randomUUID();
      stepGate.arm("turn-start");
      yield* answered({ type: "user", uuid: first, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "Self-test one." }] } });
      yield* launched.setSystemPrompt("Self-test prompt two.");
      const rewound = yield* launched.rewind(first, first);
      if (!rewound.rewound) return inconclusive(`rewind-${rewound.reason}`);
      stepGate.arm("replayed-turn-start");
      yield* answered({ type: "user", uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "Self-test one." }] } });
      write({ type: "assistant", uuid: randomUUID(), session_id: "", parent_tool_use_id: null,
        message: cliAssistantMessage({ role: "assistant", content: [{ type: "text", text: "Self-test answer." }] }, 1, config.wireModelId) });
      yield* answered({ type: "user", uuid: randomUUID(), shouldQuery: false, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "Self-test two." }] } });
      write({ type: "assistant", uuid: randomUUID(), session_id: "", parent_tool_use_id: null,
        message: cliAssistantMessage({ role: "assistant", content: [{ type: "text", text: "Self-test answer two." }] }, 3, config.wireModelId) });
      stepGate.arm("turn-start");
      yield* answered({ type: "user", uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "Self-test three." }] } });
      return selfTestVerdict(host.bodies, versions, cliVersion);
    });
    const release = ({ launched, reader }: { readonly launched: LaunchedQuery; readonly reader: Promise<unknown> }) => Effect.gen(function* () {
      yield* Queue.end(prompt);
      yield* launched.stop(false);
      yield* Effect.promise(() => launched.close());
      yield* Effect.promise(() => reader);
    });
    return yield* Effect.acquireUseRelease(acquire, use, release);
  });
}

/** Compares what the CLI sent with what a cold rotation sends: the second request holds the new prompt and the
 *  replayed rows, the CLI's own system messages, its reminders, sit where the first request had them, and no other
 *  request reached the host. */
function selfTestVerdict(bodies: readonly unknown[], versions: readonly string[], cliVersion: string): SelfTestResult {
  const failed = (failure: string): SelfTestResult => ({ passed: false, failure, conclusive: true });
  if (versions.some((version) => version !== cliVersion)) return inconclusive("version-changed");
  if (bodies.length !== 2) return failed(`requests-${bodies.length}`);
  const [first, second] = bodies.map((body) => asRecord(body));
  const lastSystem = (body: ReturnType<typeof asRecord>) => {
    const system = body?.["system"];
    return Array.isArray(system) ? asRecord(system.at(-1))?.["text"] : undefined;
  };
  if (lastSystem(first) !== "Self-test prompt one." || lastSystem(second) !== "Self-test prompt two.") return failed("system-prompt");
  const messages = second?.["messages"];
  // The CLI also sends `system` role messages (its reminders); a cold rotation sends the same ones, so the
  // conversation's own rows decide, and the system messages only by their place.
  const texts = Array.isArray(messages) ? messages.flatMap((message) => {
    const record = asRecord(message);
    const content = record?.["content"];
    return record?.["role"] === "system" ? [] : [Array.isArray(content) ? asRecord(content[0])?.["text"] : undefined];
  }) : [];
  if (!sameTexts(texts, ["Self-test one.", "Self-test answer.", "Self-test two.", "Self-test answer two.", "Self-test three."])) return failed("messages");
  return sameTexts(roles(second), [...roles(first), "assistant", "user", "assistant", "user"]) ? { passed: true } : failed("reminders");
}

/** The role of each message of a request body, in order. */
function roles(body: ReturnType<typeof asRecord>): readonly unknown[] {
  const messages = body?.["messages"];
  return Array.isArray(messages) ? messages.map((message) => asRecord(message)?.["role"]) : [];
}

function sameTexts(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

interface SelfTestHost {
  readonly url: string;
  /** The body of each model request, in order. */
  readonly bodies: unknown[];
  stop(): void;
}

/** A local Messages host that answers every streamed request with one short text answer. */
function selfTestHost(): SelfTestHost {
  const bodies: unknown[] = [];
  const event = (data: { readonly type: string; readonly [field: string]: unknown }) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });
      if (path !== "/v1/messages") return Response.json({ type: "error", error: { type: "not_found_error", message: "not served" } }, { status: 404 });
      const body: unknown = await request.json();
      bodies.push(body);
      const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      return new Response([
        event({ type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: asRecord(body)?.["model"], content: [], stop_reason: null, stop_sequence: null, usage } }),
        event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Self-test reply." } }),
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
        event({ type: "message_stop" }),
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, stop: () => { void server.stop(true); } };
}


function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
