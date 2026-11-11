import { afterEach, beforeEach } from "bun:test";
import type { NonNullableUsage, SDKAssistantMessage, SDKAssistantMessageError, SDKMessage, SDKPartialAssistantMessage, SDKRateLimitEvent, SDKRateLimitInfo, SDKResultError, SDKResultSuccess, SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawMessageStreamEvent, BetaStopReason } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { DebugLog, type DebugLogRecordInput } from "../../../../../src/infra/debug-log.js";
import { environmentReminder, parseClaudeReminder } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import type { BlockOrigin, BlockOrigins } from "../../../../../src/orchestration/agent-runtime/llm/conversions/anthropic-messages.js";
import { DISPATCH_TEXT, ENGINE_INSTRUCTIONS } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";
import type { AnthropicOperations } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import type { ModelRefusal } from "../../../../../src/infra/auth/provider-model-catalog-store.js";
import { QuotaCoordinationError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { makeBridge } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/bridge.js";
import type { BridgeConfig } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/bridge-state.js";
import type { ExtraUsage, ExtraUsageStop } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/extra-usage-guard.js";
import type { UsageWindows } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/account-usage.js";
import type { BridgeRequest } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js";
import type { InPlaceGate } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/in-place-check.js";
import type { RequestOutcome } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import { stopQuery, type CliFrame, type LaunchedQuery, type QueryLaunch } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { silentVersions } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/stderr-signals.js";
import type { TranscriptFiles } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/transcript.js";
import type { ProviderTransportContext } from "../../../../../src/orchestration/session/provider-request-audit-types.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";

/** The envelope fields that the CLI stamps on every message. The bridge reads none of them. */
export const ENVELOPE = { uuid: "00000000-0000-4000-8000-000000000000", session_id: "s" } as const;
/** Usage and cost of a turn that served nothing, as an engine that spent nothing reports them. */
const NO_USAGE: NonNullableUsage = {
  input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: "", iterations: [], fallback_credit: null, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard", speed: "standard",
};
const TURN_TOTALS: Pick<SDKResultSuccess, "duration_ms" | "duration_api_ms" | "num_turns" | "stop_reason" | "total_cost_usd" | "usage" | "modelUsage" | "permission_denials"> = {
  duration_ms: 0, duration_api_ms: 0, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: NO_USAGE, modelUsage: {}, permission_denials: [],
};

/** The fields, subtypes, and events that the CLI sends and the SDK's declared SDKMessage union omits: the `ping`
 *  event and the per-turn effort change (CLI 2.1.295 and 2.1.296). */
type CliOnlyMessage =
  | { readonly type: "stream_event"; readonly parent_tool_use_id: null; readonly event: { readonly type: "ping" } }
  | { readonly type: "system"; readonly subtype: "per_turn_effort_changed"; readonly per_turn_effort_active: boolean };
/** One of those messages as the SDK hands it on: the SDK parses each JSON line of the CLI's output and types the
 *  result as an SDKMessage without checking it, so the fixture takes the same path. */
export function cliOnlyMessage(message: CliOnlyMessage): SDKMessage {
  return JSON.parse(JSON.stringify({ ...ENVELOPE, ...message }));
}
/** A rate-limit report's info, with the CLI's internal `unifiedWindows` field that the SDK's declared type omits (CLI 2.1.295). */
export type CliRateLimitInfo = SDKRateLimitInfo & { readonly unifiedWindows?: unknown };

export const event = (value: BetaRawMessageStreamEvent, parentToolUseId: string | null = null): SDKPartialAssistantMessage =>
  ({ type: "stream_event", parent_tool_use_id: parentToolUseId, event: value, ...ENVELOPE });
/** The CLI's init message. Its defaults are the step-gate init of CLI 2.1.295; `per_turn_effort_active` is the
 *  CLI's internal field that the SDK's declared type omits (CLI 2.1.296). */
export const cliInit = (fields: Partial<Pick<SDKSystemMessage, "session_id" | "claude_code_version" | "plugins">> & { readonly per_turn_effort_active?: boolean } = {}): SDKSystemMessage => ({
  type: "system", subtype: "init", ...ENVELOPE, apiKeySource: "none", cwd: "/work", tools: [], mcp_servers: [], model: "claude-sonnet-5-5", permissionMode: "default", slash_commands: [], output_style: "default", skills: [],
  claude_code_version: "2.1.295", plugins: [{ name: "step-gate", path: "/plugins/step-gate" }], ...fields,
});
export const init = cliInit();
export const rateLimitReport = (info: CliRateLimitInfo): SDKRateLimitEvent => ({ type: "rate_limit_event", rate_limit_info: info, ...ENVELOPE });
export const turnResult = (fields: Partial<Omit<SDKResultSuccess, "type" | "subtype">>): SDKResultSuccess => ({ type: "result", subtype: "success", ...TURN_TOTALS, ...ENVELOPE, is_error: false, result: "", ...fields });
export const turnError = (fields: Pick<SDKResultError, "subtype" | "errors"> & Partial<Omit<SDKResultError, "type">>): SDKResultError => ({ type: "result", ...TURN_TOTALS, ...ENVELOPE, is_error: true, ...fields });
/** The CLI's assistant message that reports a failed request: `error` names the failure and `text` is its reply. */
export const assistantError = (error: SDKAssistantMessageError | undefined, text: string): SDKAssistantMessage => ({
  type: "assistant", parent_tool_use_id: null, ...ENVELOPE, ...(error === undefined ? {} : { error }),
  message: { id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text, citations: null }], stop_reason: null, stop_sequence: null,
    container: null, context_management: null, diagnostics: null, stop_details: null, usage: { ...NO_USAGE, cache_creation: null } },
});
/** The CLI fires the step gate plugin's hook before it sends a model request: the fake asks the query's gate there.
 *  `STEP` is a step that the CLI starts by itself, which continues its current turn. */
export const STEP = Symbol("step");
/** The step of a Flywheel request: it continues the turn after a tool-use answer and starts the next turn otherwise. */
export const REQUEST_STEP = Symbol("request-step");
export type CliOutput = SDKMessage | typeof STEP | typeof REQUEST_STEP;
/** The CLI's usage report after a response that included usage served. */
export const includedReport = rateLimitReport({ status: "allowed", resetsAt: 1_791_540_527, rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: false });
export const turnDone = turnResult({ api_error_status: null, terminal_reason: "completed" });

export const messageStart = (cacheRead = 0) => event({ type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null,
  container: null, context_management: null, diagnostics: null, stop_details: null,
  usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, cache_creation: null, inference_geo: null, iterations: null, fallback_credit: null, output_tokens_details: null, server_tool_use: null, service_tier: null, speed: null } } });
/** A model request that the gate admitted: the hook asks, then the request streams. */
export const admittedStart = (cacheRead = 0): CliOutput[] => [REQUEST_STEP, messageStart(cacheRead)];
export const text = (index: number, value: string) => [
  event({ type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } }),
  event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } }),
  event({ type: "content_block_stop", index }),
];
export const toolUse = (index: number, id: string) => [
  event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__runtime__read", input: {} } }),
  event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
  event({ type: "content_block_stop", index }),
];
export const stopReason = (reason: BetaStopReason | null) => event({
  type: "message_delta", context_management: null, delta: { stop_reason: reason, stop_sequence: null, container: null, stop_details: null },
  usage: { output_tokens: 5, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, iterations: null, fallback_credit: null, output_tokens_details: null, server_tool_use: null },
});
export const messageStop = event({ type: "message_stop" });
export const ping = cliOnlyMessage({ type: "stream_event", parent_tool_use_id: null, event: { type: "ping" } });
/** The CLI's report of one refused request: its assistant error message, then the failed turn result. */
export const refused = (error: SDKAssistantMessageError, status: number | null, reply: string): [SDKAssistantMessage, SDKResultSuccess] => [
  assistantError(error, reply),
  turnResult({ is_error: true, api_error_status: status, terminal_reason: "api_error", result: reply }),
];
export const extendedWindowRefused = refused("rate_limit", 429, "API Error: Usage credits required for 1M context · turn on usage credits at https://claude.ai/settings/usage");
/** The model reads a file: the answer that parks the query. */
export const readsFile = [...admittedStart(), ...text(0, "Reading."), ...toolUse(1, "toolu_1"), stopReason("tool_use"), messageStop];
/** The model ends its turn with visible text. */
export const answers = (value: string) => [...admittedStart(), ...text(0, value), stopReason("end_turn"), messageStop];

/** The debug line that CLI 2.1.293 writes before it dispatches each model request. */
export const MODEL_REQUEST_LINE = "2026-10-07T12:00:00.000Z [DEBUG] [API REQUEST] /v1/messages source=sdk";
/** The log id of the model request that `modelRequest` sends, unless a test names another. */
export const MODEL_LOG_ID = "log_0a1b2c";
/** A short `sending request` block of the engine's Anthropic client (CLI 2.1.306): its log id, its path, and the
 *  hosted agent that its `x-claude-code-agent-id` header names. */
export function sentBlock(logId: string, options: { readonly path?: string; readonly agent?: string } = {}): string[] {
  const path = options.path ?? "/v1/messages";
  return [
    `[Anthropic SDK DEBUG] [${logId}] sending request {`,
    "  options: {",
    `    path: "${path}?beta=true",`,
    "  },",
    "  headers: {",
    ...(options.agent === undefined ? [] : [`    "x-claude-code-agent-id": "${options.agent}",`]),
    "  },",
    "}",
  ];
}
/** One main-loop model request as the engine announces it: its request block, then its `[API REQUEST]` line. */
export const modelRequest = (logId = MODEL_LOG_ID) => [...sentBlock(logId), MODEL_REQUEST_LINE];
/** The `response start` or `response error` block that the engine's Anthropic client writes for one response at
 *  `ANTHROPIC_LOG=debug` (CLI 2.1.296). */
export function responseBlock(kind: "start" | "error", status: number, headers: { readonly [name: string]: string }, logId = MODEL_LOG_ID): string[] {
  return [
    `[Anthropic SDK DEBUG] [${logId}] response ${kind === "start" ? "start" : "error (error; no more retries left)"} {`,
    '  url: "http://127.0.0.1:1/v1/messages?beta=true",',
    `  status: ${status},`,
    "  headers: {",
    '    "content-type": "application/json",',
    '    date: "Fri, 09 Oct 2026 22:45:57 GMT",',
    ...Object.entries(headers).map(([name, value]) => `    "${name}": "${value}",`),
    "  },",
    "  durationMs: 2,",
    "}",
  ];
}
/** The line that the engine writes for each HTTP error response, with the response body. */
export const apiErrorLine = (status: number, body: string) => `2026-10-09T12:00:00.000Z [ERROR] API error (attempt 1/1): ${status} ${status} ${body}`;
/** The line that the engine writes for the SSE error event that ended a stream. */
export const streamErrorLine = (body: string) => `2026-10-09T12:00:00.000Z [ERROR] Error streaming (non-streaming fallback disabled): ${body}`;

export const U1: MessageParam = { role: "user", content: [{ type: "text", text: "Read a." }] };
export const A1: MessageParam = { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "mcp__runtime__read", input: { path: "a" } }] };
export const R1: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file a" }] }] };
export const A2: MessageParam = { role: "assistant", content: [{ type: "text", text: "Done." }] };
export const U2: MessageParam = { role: "user", content: [{ type: "text", text: "Next." }] };
/** U1 as canonical history holds it after the shared producer added its environment reminder. */
/** The environment that the fake engine states at an opening turn, unless a test names another: the one that
 *  `U1_WITH_ENVIRONMENT` states. */
export const MACOS_ENVIRONMENT = { kind: "environment", workingDirectory: "/work", isWorktree: false, isGitRepo: false, platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0" } as const;

export const U1_WITH_ENVIRONMENT: MessageParam = { role: "user", content: [{ type: "text", text: "Read a." }, { type: "text", text: environmentReminder(MACOS_ENVIRONMENT, SHELL_CAPABILITIES) }] };

/** The origins that preparation gives the blocks of a request that a test writes by hand, whose canonical entries the
 *  test does not state: each Flywheel reminder and each text of the shared host is the runtime's, and every other
 *  user text is the person's. */
export function originsOf(params: BridgeRequest): BlockOrigins {
  return params.messages.map((message) => typeof message.content === "string" ? [] : message.content.map((block): BlockOrigin => {
    if (message.role === "assistant") return "assistant";
    if (block.type === "tool_result") return "tool-result";
    if (block.type !== "text") return "person";
    const reminder = parseClaudeReminder(block.text);
    if (reminder !== undefined) return reminder.kind === "model" ? "claude-framing" : "runtime-reminder";
    return block.text === ENGINE_INSTRUCTIONS || block.text === DISPATCH_TEXT || block.text.startsWith("<system-reminder>\n") ? "host-framing" : "person";
  }));
}

export function request(messages: MessageParam[], overrides: Partial<BridgeRequest> = {}): BridgeRequest {
  return {
    model: "claude-sonnet-5-5", max_tokens: 32_000, stream: true, messages,
    system: [{ type: "text", text: "Flywheel system prompt" }],
    tools: [{ name: "mcp__runtime__read", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } } }, eager_input_streaming: true }],
    thinking: { type: "adaptive" }, output_config: { effort: "medium" },
    ...overrides,
  };
}

/** The CLI side of one query: the SDK messages the test emits, the prompt the bridge pushes, and a shared log of
 *  what the stop procedure does, in order. */
export class FakeQuery {
  /** Every frame that the bridge wrote: pushed messages and replay frames. */
  readonly pushed: CliFrame[] = [];
  /** The answer to the next rewind. */
  rewindOutcome: Effect.Success<ReturnType<LaunchedQuery["rewind"]>> = { rewound: true };
  /** The gate's answer to each step that the hook asked about, in order. */
  readonly steps: boolean[] = [];
  /** Whether the CLI's debug output announces each request that it sends, as CLI 2.1.291 to 2.1.295 do. */
  announces = true;
  /** The CLI's turn and the index of its last step. Its turn continues after a tool-use answer until an interrupt. */
  private turn = 0;
  private stepIndex = -1;
  private continues = false;
  private readonly queued: SDKMessage[] = [];
  /** The last response ended with a stop reason, so its `message_stop` completes it. */
  private completing = false;
  private reported = false;
  private wake: (() => void) | undefined;
  private ended = false;
  /** The error that ends the message stream, as the SDK throws it at a process exit it reports. */
  private failure: Error | undefined;
  private notStarted = false;
  private readonly exit = Promise.withResolvers<undefined>();
  exited = false;

  /** `reports` is "auto" when the fake reports included usage after its first complete response, as the CLI of a
   *  subscription login does, and "manual" when the test emits each report itself. */
  constructor(readonly launch: QueryLaunch, private readonly log: string[], private readonly reports: "auto" | "manual") {
    void (async () => {
      for await (const message of launch.prompt) {
        this.pushed.push(message);
        if (message.type === "assistant") log.push("replay:assistant");
        else if (message.shouldQuery === false) {
          log.push("replay:user");
          // The CLI answers a replayed row with a turn result that names it.
          this.emit({ ...turnDone, user_message_uuid: message.uuid });
        } else log.push("push");
      }
    })();
  }

  /** Emits CLI output in order. A step reaches the query's gate at once, as the hook's socket does. */
  emit(...messages: CliOutput[]): void {
    for (const message of messages) {
      if (message === STEP || message === REQUEST_STEP) {
        if (message === REQUEST_STEP && !this.continues) {
          this.turn += 1;
          this.stepIndex = -1;
        }
        this.stepIndex += 1;
        const admitted = this.launch.stepGate.ask({ turnId: `turn-${this.turn}`, index: this.stepIndex, messageCount: 1 });
        this.steps.push(admitted);
        // The CLI announces a request that the gate admitted before it sends it.
        if (admitted && this.announces) this.launch.onStderrLine(MODEL_REQUEST_LINE);
        continue;
      }
      const stop = message.type === "stream_event" && message.event.type === "message_delta" ? message.event.delta.stop_reason : undefined;
      if (stop !== undefined) this.continues = stop === "tool_use";
      this.queued.push(message);
      if (stop !== undefined) this.completing = stop !== null;
      if (message.type === "stream_event" && message.event.type === "message_stop" && message.parent_tool_use_id === null) {
        // The CLI reports after the first complete response of its process; a cut response gets no report.
        if (this.completing && !this.reported && this.reports === "auto") this.queued.push(includedReport);
        if (this.completing) this.reported = true;
        this.completing = false;
      }
    }
    this.wake?.();
  }

  /** The CLI's message stream ends, as when its process exits. */
  end(): void {
    this.ended = true;
    this.wake?.();
  }

  /** The engine's process could not start: the SDK reports its exit as the stream's error. */
  failStart(error: Error): void {
    this.notStarted = true;
    this.failure = error;
    this.exited = true;
    this.exit.resolve(undefined);
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    while (true) {
      const next = this.queued.shift();
      if (next !== undefined) yield next;
      else if (this.ended) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  interrupt = async () => { this.log.push("interrupt"); this.continues = false; return undefined; };
  setSystemPrompt = (prompt: string) => Effect.sync(() => { this.log.push(`system-prompt:${prompt}`); });
  rewind = (target: string, lastSeen: string) => Effect.sync(() => {
    this.log.push(`rewind:${this.rowName(target)}<=${this.rowName(lastSeen)}`);
    return this.rewindOutcome;
  });

  /** A row id as the test names it: `push<N>` or `replay<N>` for the N-th frame of that kind, else `row`. */
  rowName(uuid: string): string {
    const frames = this.pushed.filter((frame) => frame.type === "user");
    const frame = frames.find((candidate) => candidate.uuid === uuid);
    if (frame === undefined) return "row";
    const kind = frame.shouldQuery === false ? "replay" : "push";
    return `${kind}${frames.filter((candidate) => (candidate.shouldQuery === false) === (kind === "replay")).indexOf(frame)}`;
  }
  close = () => { this.log.push("close"); this.exited = true; this.exit.resolve(undefined); this.end(); };
  /** The fake's gate has no socket; every step that the hook asked reaches it. */
  stepGateEvidence = () => ({ asks: this.steps.length, rejected: 0, socketPathBytes: 0 });

  /** The owned process of the query. */
  process() {
    return {
      spawn: () => { throw new Error("no spawn in a unit test"); },
      exited: () => this.exit.promise,
      running: () => !this.exited,
      cannotStart: () => this.notStarted,
      terminate: async () => { this.log.push("terminate"); this.exited = true; this.exit.resolve(undefined); },
      close: async () => ({ settled: true }) as const,
    };
  }
}

/** A launched query over a fake CLI, and the fake CLI that the test drives. `refreshLockHeld` is whether the
 *  login's refresh lock holds the query's stop. */
export function launchFakeQuery(launch: QueryLaunch, log: string[], reports: "auto" | "manual", refreshLockHeld: () => boolean = () => false) {
  const query = new FakeQuery(launch, log, reports);
  const owned = query.process();
  const stopFiles = { refreshLockHeld, removeKilledLeftovers: () => { log.push("leftovers"); } };
  const launched: LaunchedQuery = {
    query, process: owned, stop: (turnActive) => stopQuery(query, owned, launch.session.id, stopFiles, turnActive), close: async () => { await owned.close(); },
    setSystemPrompt: query.setSystemPrompt, rewind: query.rewind, stepGateEvidence: query.stepGateEvidence,
  };
  return { query, launched };
}

export interface Harness {
  readonly config: BridgeConfig;
  readonly ops: AnthropicOperations;
  readonly queries: FakeQuery[];
  readonly log: string[];
  readonly files: Map<string, string>;
  readonly lock: { held: boolean };
  /** The refusals that the bridge recorded for its model, in order. */
  readonly refusals: ModelRefusal[];
  /** The reset that each quota mark of the bridge's account named, in order: undefined when the CLI reported none. */
  readonly quotaMarks: (number | undefined)[];
  /** Each stop of the extra-usage guard that the bridge reported, in order. */
  readonly usageStops: ExtraUsageStop[];
  /** The account's usage windows that the bridge recorded, in order. */
  readonly usageWindows: UsageWindows[];
  /** How each request ended for the login and its CLI, as the bridge recorded it, in order. */
  readonly outcomes: RequestOutcome[];
  advance(ms: number): Promise<void>;
}

export const records: DebugLogRecordInput[] = [];
export const payloads = (type: string) => records.filter((record) => record.type === type).map(({ payload }) => payload);
/** Collects every diagnostic record of each test in `records`. A test file calls it once at its top level. */
export function forwardDiagnostics(): void {
  beforeEach(async () => {
    records.length = 0;
    await DebugLog.forward((record) => { records.push(record); });
  });
  afterEach(async () => { await DebugLog.close(); });
}

/** Runs `body` against one bridge under a test clock; the bridge's scope closes when the body ends. */
export function withBridge(body: (harness: Harness) => Promise<void>, options: { readonly email?: string; readonly transcriptRemovalFails?: boolean; readonly launchesBeforeFailure?: number; readonly inPlace?: Effect.Success<ReturnType<InPlaceGate["status"]>>; readonly quotaRowRefused?: boolean; readonly silentCliVersions?: Set<string>; readonly extraUsage?: ExtraUsage; readonly reportsExtraUsage?: boolean; readonly reports?: "auto" | "manual"; readonly openingEnvironment?: BridgeConfig["openingEnvironment"]; readonly engineShell?: string; readonly demand?: BridgeConfig["demand"]; readonly configDir?: string } = {}): Promise<void> {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const queries: FakeQuery[] = [];
    const log: string[] = [];
    const lock = { held: false };
    const files = new Map<string, string>();
    const refusals: ModelRefusal[] = [];
    const quotaMarks: (number | undefined)[] = [];
    const usageStops: ExtraUsageStop[] = [];
    const usageWindows: UsageWindows[] = [];
    const outcomes: RequestOutcome[] = [];
    // The bridge takes real session locks in the login's directory; its transcripts go to `files`. A directory that
    // the harness creates goes after the bridge closed and released its locks; a test that reads the locks after the
    // close gives its own.
    const configDir = options.configDir ?? mkdtempSync(join(tmpdir(), "bridge-login-"));
    if (options.configDir === undefined) yield* Effect.addFinalizer(() => Effect.sync(() => { rmSync(configDir, { recursive: true, force: true }); }));
    const transcriptFiles: TranscriptFiles = {
      realpath: (path) => path, write: (path, value) => { files.set(path, value); return false; }, remove: (path) => {
        if (options.transcriptRemovalFails === true) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
        files.delete(path);
      },
      removeEmptyDirectory: () => {},
      list: () => [], modifiedMs: () => undefined,
    };
    const config: BridgeConfig = {
      launchQuery: (launch): LaunchedQuery => {
        if (options.launchesBeforeFailure !== undefined && queries.length >= options.launchesBeforeFailure) throw new Error("the CLI did not start");
        const { query, launched } = launchFakeQuery(launch, log, options.reports ?? "auto", () => lock.held);
        queries.push(query);
        return launched;
      },
      inPlace: { status: () => Effect.succeed(options.inPlace ?? "unlisted") }, silentVersions: silentVersions(options.silentCliVersions),
      openingEnvironment: (cwd) => options.openingEnvironment === undefined ? { ...MACOS_ENVIRONMENT, workingDirectory: cwd } : options.openingEnvironment(cwd),
      engineShell: () => options.engineShell,
      configDir, projectRoot: "/work", wireModelId: "claude-sonnet-5-5", contextLimit: 1_000_000, transcriptFiles,
      recordModelRefusal: (refusal) => { refusals.push(refusal); },
      markQuotaExhausted: (resetsAtMs) => {
        quotaMarks.push(resetsAtMs);
        if (options.quotaRowRefused === true) throw new QuotaCoordinationError({ message: "The account's quota row did not take the mark", provider: "claude_agent_sdk", reason: "row-refused" });
        return { exhaustion: { exhaustedAtMs: 0, resetsAtMs: resetsAtMs ?? 300_000, hold: { kind: "usage_limit", stated: true } }, newlyExhausted: true, reportedResetAtMs: resetsAtMs };
      },
      // Every test serves the included route, whose guard refuses extra usage, unless it asks for the paid route.
      extraUsage: options.extraUsage ?? "refuse", reportsExtraUsage: () => options.reportsExtraUsage ?? true, accountEmail: () => options.email, onExtraUsageStop: (stop) => { usageStops.push(stop); },
      recordUsage: (windows) => { usageWindows.push(windows); },
      recordOutcome: (outcome) => { outcomes.push(outcome); },
      providerSessionKey: "conversation-1",
      ...(options.demand === undefined ? {} : { demand: options.demand }),
    };
    const ops = yield* makeBridge(config);
    const context = yield* Effect.context<never>();
    const advance = (ms: number) => Effect.runPromiseWith(context)(TestClock.adjust(ms));
    yield* Effect.promise(() => body({ config, ops, queries, log, files, lock, refusals, quotaMarks, usageStops, usageWindows, outcomes, advance }));
  })).pipe(Effect.provide(TestClock.layer())));
}

/** Lets the bridge's fibers and the fake's loops run until `ready` holds.
 *  The bound is wall time, not a turn count: a launch reads the engine and
 *  login stamps from disk, which takes many more turns on a loaded machine. */
export async function until(ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!ready() && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  if (!ready()) throw new Error("the bridge did not reach the expected state");
}

export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Starts one request and returns its event stream, read to its end or its failure. `types` holds the service's
 *  events; `contexts` holds the bridge's record of what the engine added, which is no service event. */
export async function send(ops: AnthropicOperations, params: BridgeRequest, signal = new AbortController().signal) {
  const { data } = await ops.createStream(params, { sharedHost: true, origins: originsOf(params), signal, headers: {} });
  const types: string[] = [];
  const contexts: ProviderTransportContext[] = [];
  const read = (async () => {
    for await (const item of data) {
      if (item.type === "transport_context") contexts.push(item.context);
      else types.push(item.type);
    }
    return types;
  })();
  return { data, types, contexts, read, error: read.then(() => undefined, (error: unknown) => error) };
}

/** The `sending request` block that the engine's Anthropic client writes before each request at `ANTHROPIC_LOG=debug`
 *  (CLI 2.1.296), for a request with `fields` in its body and `betas` in its header. */
export function requestBlock(path: string, fields: readonly string[], betas: string): string[] {
  return [
    "[Anthropic SDK DEBUG] [log_6f9c8d] sending request {",
    `  url: "http://127.0.0.1:1${path}?beta=true",`,
    "  options: {",
    `    path: "${path}?beta=true",`,
    "    body: {",
    ...fields.map((field) => field === "model" ? '      model: "claude-sonnet-5-5",' : `      ${field}: [Object ...],`),
    "    },",
    "  },",
    "  headers: {",
    `    "anthropic-beta": "${betas}",`,
    '    authorization: "***",',
    "  },",
    "}",
  ];
}

/** Reaches the gate as the CLI does: a call of `read` for `toolUseId` that waits for Flywheel's result. */
export async function callHandler(query: FakeQuery, toolUseId: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await query.launch.mcpServer.connect(serverSide);
  const client = new Client({ name: "claude-cli", version: "0.0.0" });
  await client.connect(clientSide);
  return client.callTool({ name: "read", arguments: { path: "a" }, _meta: { "claudecode/toolUseId": toolUseId } });
}

/** One parked conversation: U1 answered with a read of `a`. */
export async function parked(harness: Harness) {
  const first = await send(harness.ops, request([U1]));
  const [query] = harness.queries;
  if (query === undefined) throw new Error("no query started");
  query.emit(init, ...readsFile);
  await first.read;
  return { first, query };
}

/** The engine writes `lines` to its debug output, in order. */
export function logLines(query: FakeQuery | undefined, lines: readonly string[]): void {
  for (const line of lines) query?.launch.onStderrLine(line);
}

/** An engine that could not read its login before it sent any model request. */
export function localLoginRefusal(query: FakeQuery | undefined): void {
  logLines(query, ["2026-10-15T00:28:13.676Z [ERROR] API error (attempt 1/11): Could not resolve authentication method."]);
  query?.emit(...refused("authentication_failed", null, "Not logged in · Please run /login"));
}
