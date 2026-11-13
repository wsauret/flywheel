import type Anthropic from "@anthropic-ai/sdk";
import type { Cause, Deferred, Fiber, Queue, Scope } from "effect";
import type { ModelRefusal } from "../../../infra/auth/provider-model-catalog-store.js";
import type { ProviderDemand } from "../../agent-runtime/llm/types.js";
import type { UsageWindows } from "./account-usage.js";
import type { AssistantAssembler, SettlementEvidence } from "./assistant-assembler.js";
import type { AbortSource, AdmittedWindow, BridgeRequestInput } from "./bridge-requests.js";
import type { CliMessage, CliView, PlacedReminder, QueryIdentity } from "./cli-view.js";
import type { ExtraUsage, ExtraUsageEvidence, ExtraUsageStop, UsageReports } from "./extra-usage-guard.js";
import type { InPlaceGate } from "./in-place-check.js";
import type { OpeningStatement, ReplayAcks } from "./in-place.js";
import type { RequestOutcome } from "./login-observations.js";
import type { CliFrame, LaunchedQuery, QueryLaunch } from "./query-launcher.js";
import type { QueryEngine } from "./query-engine.js";
import type { StartPlan } from "./request-plan.js";
import type { CliErrorReport, QuotaMark, SdkInput } from "./sdk-events.js";
import type { ServiceRequests, WireFailure } from "./service-requests.js";
import type { DebugLine, RequestLine, SilentVersions, StoppedQuery } from "./stderr-signals.js";
import type { StepAsk, StepGate, StepGateEvidence, StepGateFault } from "./step-gate.js";
import type { ToolGate } from "./tool-gate.js";
import type { TranscriptFiles, WrittenTranscript } from "./transcript.js";

// The state that the bridge's actor owns (bridge.ts), and the inputs that reach the actor through its one queue.

/** The configuration of one bridge. The provider client builds one bridge for each client it builds. */
export interface BridgeConfig {
  /** Starts one query: `createQueryLauncher` over the runtime generation's launcher. */
  readonly launchQuery: (launch: QueryLaunch) => LaunchedQuery;
  /** The account's `CLAUDE_CONFIG_DIR`, where rotation transcripts go. */
  readonly configDir: string;
  /** Whether a live query's CLI version may rotate in place (rule 13). */
  readonly inPlace: InPlaceGate;
  /** The canonical environment of a working directory now (`environmentFacts`), which an in-place rotation that
   *  replays a conversation's opening row must match. A transcript and the live engine both state the canonical facts
   *  with the engine's shell (`engineShell`), so equal canonical facts give equal engine statements. */
  readonly openingEnvironment: OpeningStatement["environment"];
  /** The shell that the engine names, read when a rotation transcript is written (`engineShell`). */
  readonly engineShell: () => string | undefined;
  /** The CLI versions whose debug output went silent. Bridge rule 4 finds the requests that the CLI sends by itself
   *  only through that output, so the bridge serves no request on such a version. */
  readonly silentVersions: SilentVersions;
  /** The working directory when canonical history holds no environment reminder. */
  readonly projectRoot: string;
  readonly wireModelId: string;
  /** Records a refusal that the bridge answered itself, so the adapter never saw it (`AccessProviderBuild`). It
   *  returns at once and never fails. */
  readonly recordModelRefusal: (refusal: ModelRefusal) => void;
  /** Marks the account's allowance spent until a reset, for the error map (`QuotaMark`). */
  readonly markQuotaExhausted: QuotaMark;
  /** Whether the account may serve requests from Claude extra usage (`UsageReports`). */
  readonly extraUsage: ExtraUsage;
  /** Whether the CLI's usage reports of the login state extra usage, read when a query starts (`CliLogin`). */
  readonly reportsExtraUsage: () => boolean;
  /** The email of the account that the login names, read when a rotation transcript is written (`CliLogin`). The
   *  CLI of a Claude login adds it as a `session_context` reminder after the first user message; a transcript
   *  without that row makes the CLI add the reminder to the newest user message instead. */
  readonly accountEmail: () => string | undefined;
  /** Tells the person that the extra-usage guard stopped the account. It returns at once and never fails. */
  readonly onExtraUsageStop: (stop: ExtraUsageStop) => void;
  /** Records the account's plan windows that a CLI report names (`UsageReadings`). It returns at once and never
   *  fails. */
  readonly recordUsage: (windows: UsageWindows) => void;
  /** Records how a request of the login ended for the login and its CLI (`LoginObservations`): served, refused for
   *  its login, or cut by an exit of the CLI. It returns at once and never fails. */
  readonly recordOutcome: (outcome: RequestOutcome) => void;
  /** The conversation key of the client's lifetime. Its queries share the bridge's one session id and keep the CLI
   *  between requests until the lifetime ends. */
  readonly providerSessionKey: string;
  readonly transcriptFiles?: TranscriptFiles;
  /** The engine demand of the session whose client this is (`ProviderSessionLifetime.demand`), which hears each end
   *  of the session's engine that a plan can repair (`reportEngineEnd`). */
  readonly demand?: ProviderDemand;
}

export type SinkEvent = Anthropic.RawMessageStreamEvent;
/** The events of one admitted request, as the shared Anthropic adapter reads them. */
type Sink = Queue.Queue<SinkEvent, Error | Cause.Done>;

export interface OpenRequest {
  readonly id: number;
  readonly sink: Sink;
  readonly signal: AbortSignal;
  /** What the request asked for, so that a recoverable refusal can send it again. */
  readonly view: CliView;
  /** The window of the request's admission, which a query that the request starts asks for (`BridgeState.refusedWindow`). */
  readonly window: AdmittedWindow;
  /** The request already went to a fresh engine once, after an engine-local fault (an unread login or an unreachable
   *  step gate). A second such fault is permanent for the request. */
  freshEngineRetried: boolean;
}

type Phase =
  /** The bridge pushed the request and admits the next `message_start`. */
  | { readonly kind: "awaiting"; readonly request: OpenRequest }
  /** `refused`: the CLI announced a refusal of the response, whose stop reason the stream still brings. */
  | { readonly kind: "streaming"; readonly request: OpenRequest; readonly assembler: AssistantAssembler; readonly refused?: true }
  /** The CLI cut the request or reported an error; the bridge waits for its report and its turn result. `streamed`
   *  is true when the adapter already read events of the request, which then cannot be sent again. */
  | { readonly kind: "failing"; readonly request: OpenRequest; readonly streamed: boolean; report: CliErrorReport | undefined }
  | { readonly kind: "parked"; readonly toolUseIds: readonly string[] }
  | { readonly kind: "idle" };

export interface LiveQuery {
  readonly id: number;
  readonly sessionId: string;
  readonly launched: LaunchedQuery;
  readonly toolGate: ToolGate;
  readonly stepGate: StepGate;
  readonly prompt: Queue.Queue<CliFrame, Error | Cause.Done>;
  /** The answers to replayed rows, which the SDK reader takes before the actor sees them. */
  readonly acks: ReplayAcks;
  /** Holds the timers and the owned CLI process. */
  readonly scope: Scope.Closeable;
  /** The window that the query's engine fixed at its start. A later request with another window continues the query
   *  as it is; only a query that a request starts takes that request's window. */
  readonly contextLimit: number;
  identity: QueryIdentity;
  /** The next admitted request follows a rotation, so its cache read is recorded (bridge rule 7). */
  rotated: boolean;
  /** What the CLI holds: canonical history up to the last request, then the assembled answers. */
  readonly messages: CliMessage[];
  /** The CLI row id of each message in `messages` that the bridge wrote as a user row (in-place.ts). */
  readonly rows: Map<number, string>;
  phase: Phase;
  /** The CLI ended its turn, so an interrupt would not settle. */
  turnEnded: boolean;
  /** The gate refused a step of the CLI's own, so the CLI holds what it added for that step and its copy is no
   *  longer Flywheel's. The next request starts a new query. */
  diverged: boolean;
  /** Turn results the CLI still owes for turns the bridge already ended. */
  owedTurnResults: number;
  /** A rotation transcript that the CLI has not read yet. */
  transcript: WrittenTranscript | undefined;
  timer: Fiber.Fiber<void> | undefined;
  /** Counts the timers armed for this query. A timer event that names an older count is stale: interrupting a
   *  timer fiber cannot recall the event it already put in the inbox. */
  armed: number;
  admitted: number;
  /** The stop reason of the last admitted request once the actor read it. The next admission clears it. */
  endedWith: string | undefined;
  /** The model requests that the CLI's debug output announced, in the order the actor read them. */
  readonly requestLines: RequestLine[];
  /** The engine's service requests, keyed by log id (bridge rule 4). */
  readonly requests: ServiceRequests;
  /** The service's failure of the query's newest main-loop model request, once its record is complete. An answer that
   *  the CLI decides at its turn end (`decidedAtTurnEnd`) waits here for the error map of that turn end. */
  answer: WireFailure | undefined;
  /** The requests that the bridge recorded as hidden. */
  hidden: number;
  /** The module was turned off while the query was busy, so it releases its CLI as soon as it comes to rest. */
  releaseAtRest: boolean;
  pings: number;
  cliVersion: string | undefined;
  /** The CLI's usage reports and the extra-usage guard over them. */
  readonly usage: UsageReports;
  readonly signIn: QueryEngine["signIn"];
  /** The query answered a request, or the query that it rotated from did. */
  served: boolean;
  /** The claims of the anticipations that the query's engine serves (`Claim`). The release of the last one stops the
   *  engine when it rests idle; a busy engine is held by its request. A claim on the reservation that the query took
   *  is not among them. */
  claims: number;
}

/** How one stop ends its query: whether a turn is active, so the stop interrupts it, whether the next request must
 *  start a new query, the error that fails the open request, and whether the open request stays for a resend. */
export interface StopOptions {
  readonly turnActive: boolean;
  readonly poisoned: boolean;
  readonly error?: Error;
  readonly keepRequest?: boolean;
}

/** The engine of one query and what its start fixed, before the query admits its first request. */
export interface StartedEngine {
  readonly id: number;
  readonly sessionId: string;
  /** The window that the engine fixed at its start. */
  readonly contextLimit: number;
  /** Holds the engine's close, and once a query takes the engine, its timers. */
  readonly scope: Scope.Closeable;
  readonly stepGate: StepGate;
  readonly engine: QueryEngine;
  /** The answers to replayed rows, which the engine's SDK reader takes before the actor sees them. */
  readonly acks: ReplayAcks;
  /** The engine's usage reports, which its SDK reader hands over as they arrive. */
  readonly usage: UsageReports;
  readonly transcript: WrittenTranscript | undefined;
  /** The CLI row id of each history message that the transcript wrote as a user row (`LiveQuery.rows`). */
  readonly historyRows: ReadonlyMap<number, string>;
}

/** The engine that the bridge started for an anticipated request (`LLMClient.anticipate`). A request takes it only
 *  when it comes with the same launch values, window, history, reminders, and delivery: the engine read that history
 *  from its transcript. */
export interface Reservation extends StartedEngine {
  readonly identity: QueryIdentity;
  readonly history: StartPlan["history"];
  readonly reminders: readonly PlacedReminder[];
  readonly delivery: StartPlan["delivery"];
  readonly reservedAt: number;
  /** The claims that hold the engine (`Claim`): it ends when the last of them is released. */
  claims: number;
  /** What the engine's readers offered while it was reserved, in order, for the query that takes it. */
  readonly inputs: EngineInput[];
}

/** The state that the bridge's actor owns. */
export interface BridgeState {
  live: LiveQuery | undefined;
  /** The engine of an anticipated request that has not come yet. It exists only while no query is live. */
  reserved: Reservation | undefined;
  /** How the last query ended, for the trigger of the next one. */
  ended: "released" | "poisoned";
  /** The last stopped query. Its CLI can still announce a model request that it started before the stop reached it. */
  stopped: StoppedQuery | undefined;
  queries: number;
  lastPromptTokens: number;
  /** The last refusal of the extended window that a query of the bridge met: the window that it left open, and the
   *  eligibility revision of the request that met it. A query that a request admitted at that revision or earlier
   *  starts asks for at most that window, because its admission was read before the refusal was published. A later
   *  admission already states what the published evidence grants: the standard window while the refusal applies, and
   *  the extended window again once it expired or an access check cleared it. */
  refusedWindow: AdmittedWindow | undefined;
}

/**
 * What decided one stop, for its `provider.claude_sdk.query.stopped` record: the stop reason, the rule or branch
 * that matched, and the kinds and counts that the rule read. It holds no content.
 */
export type StopDecision =
  /** Bridge rule 1: the assembler's settlement rule and what it read. */
  | { readonly reason: "settlement"; readonly rule: SettlementEvidence["rule"]; readonly evidence: Omit<SettlementEvidence, "rule"> }
  /** Bridge rule 4: an unadmitted `message_start` on the SDK stream, or a retry line on stderr. */
  | { readonly reason: "hidden-request"; readonly rule: "unadmitted-message-start" | "retry-line" }
  | { readonly reason: "cli-error"; readonly rule: "turn-result-during-request" | "error-hold-expired" | "api-error-line" | "stream-error-line"; readonly evidence: CliErrorEvidence }
  /** `engine-not-started`: the engine's process could not start (`OwnedClaudeProcess.cannotStart`). */
  | { readonly reason: "cli-exited"; readonly rule: "sdk-stream-ended" | "sdk-stream-failed" | "engine-not-started"; readonly evidence?: { readonly errorClass: string } }
  /** The step gate does not hold, so the bridge refuses to serve, or sends the request once more on a fresh engine. */
  | { readonly reason: "step-gate"; readonly rule: StepGateFault; readonly evidence: StepGateEvidence & { readonly retry?: "fresh-engine" } }
  /** The query's CLI version announces no model request, so the bridge cannot see a request of the CLI's own. */
  | { readonly reason: "debug-output"; readonly rule: "requests-unannounced" }
  | { readonly reason: "turn-ended"; readonly rule: "turn-result-at-rest" }
  /** Bridge rule 14: the guard stopped an account whose extra usage is refused. */
  | { readonly reason: "extra-usage"; readonly rule: ExtraUsageEvidence }
  | { readonly reason: "abort"; readonly rule: AbortSource }
  /** The module was turned off, or the last claim on the idle engine was released. */
  | { readonly reason: "release"; readonly rule: "module-off" | "released" }
  /** The planner's trigger for the new query. */
  | { readonly reason: "rotation"; readonly rule: StartPlan["trigger"]["kind"]; readonly evidence?: { readonly field?: string; readonly inPlace?: string } }
  | { readonly reason: "close"; readonly rule: "bridge-closed" };

/** The kinds that a failed request's stop read: the CLI's error kind and the turn result's status and reason. */
export interface CliErrorEvidence {
  readonly report: string;
  readonly status?: number;
  readonly terminalReason?: string;
  /** The window at which the bridge sent the open request again after a refusal of the extended window. */
  readonly resentAt?: number;
  readonly retry?: "fresh-engine";
  /** The service's own answer that the debug output logged: an HTTP error or an SSE error event. */
  readonly wire?: "http" | "stream";
}

/** What one engine's readers offer (`observeEngine`): an SDK input, the end of the SDK stream, or a line of its debug
 *  output. */
type EngineEvent =
  | { readonly kind: "sdk"; readonly input: SdkInput }
  | { readonly kind: "sdk-end"; readonly error: unknown }
  | DebugLine;

/** One event of the engine of query `query`, from the engine's launch on. */
export interface EngineInput {
  readonly kind: "engine";
  readonly query: number;
  readonly event: EngineEvent;
}

export type Inbox =
  | BridgeRequestInput
  | EngineInput
  | { readonly kind: "step-refused"; readonly query: number; readonly sessionId: string; readonly step: StepAsk }
  | { readonly kind: "timer"; readonly query: number; readonly armed: number }
  /** A claim on the engine of query `query` was released: on its reservation, or on the live query. */
  | { readonly kind: "claim-released"; readonly query: number; readonly held: "reserved" | "live" }
  | { readonly kind: "module-off" }
  | { readonly kind: "close"; readonly done: Deferred.Deferred<void> };
