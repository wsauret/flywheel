import type { ConnectionState } from "../../infra/output-blocks.js";
import type { ChatInput } from "../../infra/chat-input.js";
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js";
import type { SessionNoticeOperation } from "../../infra/session-notice.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { ReasoningEffort } from "../../infra/llm/models.js";
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js";
import type { SessionFactWriter } from "../session/session-fact-writer.js";
import type { CommittedTree } from "../session/conversation/conversation-projection.js";
import type { HandoffToolSchema } from "../workflow-host/handoff-tool-schema.js";
import type { InputSource, LogicalTurnStartedContext, TurnEndedContext, TurnParkedContext } from "../../infra/agent-loop-events.js";
import type { ProviderRequestAuditWriter } from "./llm/provider-request-audit.js";
import type { UsageSettlement } from "./usage-settlement.js";
import type { BackgroundExecutionOwner } from "./background-execution-owner.js";
import type { AfterToolCallHook } from "./agent-loop-tools.js";
import type {
  CacheRetention,
  ContentBlock,
  ConversationMessage,
  ServingAttempt,
  StreamEvent,
  TurnModelClient,
} from "./llm/types.js";
import type { SystemPromptTiers } from "./llm/system-prompt-tiers.js";
import type { PromptPrefixHold } from "./prompt-prefix-hold.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { ModuleRuntimes } from "../../infra/module-runtime.js";
import type { CapabilityAccess, ToolAttributionIdentity } from "./tools/types.js";
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js";
import type { CurrentTurnInterruption } from "./run-lifecycle.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js";
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js";
import type { ReadCommandEvidence } from "../../workflows/output-contract/evidence.js";
import type { StreamingEditValidationService } from "./tools/streaming-edit-validation.js";
import type { AgentRunTally, WaitExpiry } from "./agent-loop-state.js";

interface HandoffContent {
  [key: string]: unknown;
}

type UserMessageOrigin = "user" | "system";

export interface FinalizedCheckpointSwap {
  readonly kind: string;
  readonly key: string;
  readonly expectedRaw: string;
}

/** What follows a context reset: the next model request (`continue`), or
 *  the input wait with no request (`park`), as after a /compact the person
 *  asked for while the session was parked. */
export type CompactionAfter = "continue" | "park";

/** Durable-compaction record boundary for the event-sourced path. Records each
 *  successful context reset so resume from the session tree reconstructs
 *  from the reset branch. `tokensBefore` is the runtime's pre-compaction
 *  estimate of the whole next prompt (read from the running token anchor).
 *  `additions` are the messages that open the fresh context, which the
 *  record commits with the reset; `after` says whether a request answers
 *  them. The returned messages (when present) end with the additions and
 *  replace the loop's working history with the tree's reconstruction. */
export type RecordCompaction = (input: {
  tokensBefore: number;
  additions: readonly ConversationMessage[];
  after: CompactionAfter;
  /** The loop waits for the person on the last turn's recorded turn end, so
   *  the reset carries that record past itself. Absent means false. */
  carryTurnEnd?: boolean;
  measureTokensAfter: (messages: readonly ConversationMessage[]) => number;
  /** Withdraws a voluntary reset before writer admission, never after acceptance. */
  signal?: AbortSignal;
}) => Promise<ReadonlyArray<ConversationMessage> | undefined>;

/** A prepared installation: the messages that open the fresh context, and
 *  the measure of a post-reset history, without mutating history before
 *  durable commit. */
export interface CompactionInstallation {
  readonly additions: readonly ConversationMessage[];
  /** Tokens of the whole next prompt over `messages`, which end with the additions. */
  measure(messages: readonly ConversationMessage[]): number;
  /** Installs the post-reset history. `recorded` says that `messages` are the
   *  durable record's reconstruction, which holds the additions already;
   *  otherwise the installation appends them. */
  install(messages: ConversationMessage[], recorded: boolean): Promise<number>;
}

export interface HistorySink {
  append(message: ConversationMessage, entryId?: string): void | Promise<void>;
  reserveId?: () => Promise<string>;
  releaseId?: (id: string) => void;
}

/** How the loop's conversation history is made durable. The sink is constructed
 *  for one of two durability shapes:
 *  - event-sourced (chat, workflow workers): every pushed message is appended
 *    to the durable conversation tree through `history`; compaction goes through
 *    `recordCompaction`.
 *    The agent runtime never imports session-tree modules; these callbacks are
 *    the boundary.
 *  - none: nothing outlives the loop. */
export interface AgentLoopPersistence {
  history: HistorySink;
  /** Validated source for a child fork when history has a durable authority. */
  captureCommittedForkMessages?: () => Promise<ReadonlyArray<ConversationMessage>>;
  /** Durably records that a person interrupted the running turn and returns
   *  the model-visible record, so the parked loop holds the same history a
   *  restarted one rebuilds from the tree. Absent where nothing outlives the
   *  loop. */
  recordInterruption?: () => Promise<ConversationMessage>;
  recordCompaction?: RecordCompaction;
  /** The durable tree as the storage that `history` writes holds it, so a
   *  reader at loop start folds no second copy of the conversation. Absent
   *  where no durable tree holds the history. */
  committedTree?: () => Promise<CommittedTree>;
}

/** Where the first turn's user message comes from:
 *  - `fresh`: the loop starts with no history and appends `instruction` as
 *    the first user message.
 *  - `continue`: the loop starts with `priorMessages`, which nothing has
 *    answered with a user message yet, and appends `instruction` as the next
 *    user message. A pre-start of a chat's next send seeds so, because the
 *    person's message that it stands for is not in the tree.
 *  - `resume`: `priorMessages` already end with the current turn's user
 *    message (chat and workers commit it to the tree before the runner
 *    starts), so the seed step is skipped. */
export type AgentLoopSeed =
  | { kind: "fresh" }
  | { kind: "continue"; priorMessages: ConversationMessage[] }
  | { kind: "resume"; priorMessages: ConversationMessage[] };

/** Where a maintenance runner starts. A maintenance runner starts from an
 *  already parked session to run a queued compaction or to hold the runtime
 *  for work under the session: its first compact or hold returns to the input
 *  wait instead of continuing the task. `awaitsPerson` says that the
 *  session's last turn waits for the person, as an interrupt, an unexpected
 *  exit, or a stall leaves it. That wait then needs the person's message or
 *  Resume before a request, as a park after an interrupt does, and a message
 *  from another session or a background notification folds into history.
 *  `turnEndWaits` says that the wait rests on a recorded turn end, which a
 *  stall does not record, so a reset carries that record past itself. */
export interface AgentLoopMaintenance {
  readonly awaitsPerson: boolean;
  readonly turnEndWaits: boolean;
}

/** The committed wait batch and any input committed before the new loop attached.
 *  `parkOnly` is a property of the restored chain: an unexpected exit or an
 *  ordinary stop cut the wait after its batch, so no continuation authority
 *  covers it, even under a later planned replacement's successor. The loop
 *  then parks the turn on its work with no expiry and never starts a request
 *  itself: the completion of work that runs or that registers later, a
 *  message, or the person's Resume wakes the turn. A chain of planned cuts
 *  alone keeps the original deadline and the nothing-pending notice.
 *  `expiry` is the duration that the wait call asked for and its original
 *  deadline, absent for a reply wait, which has none, and `replyWaitIds`
 *  names the reply waits that the wait holds (`OpenWait`). `requestOwed`
 *  says that input committed after the wait that no request answered, so
 *  the loop runs that request instead of parking first. `woken` says that
 *  such input ended the wait (`endsOpenWait`), so the loop opens no wait. */
export interface RestoredAgentWait {
  readonly expiry?: WaitExpiry;
  readonly replyWaitIds: readonly string[];
  readonly requestOwed?: true;
  readonly woken?: true;
  readonly parkOnly?: true;
}

interface AgentLoopLifecycle {
  onHandoffStarted?: () => void;
  /** A runtime-cut background wait, rebuilt from its committed tool batch. */
  readonly restoredWait?: RestoredAgentWait;
  /** The open wait of a running turn that a planned replacement cut
   *  (`continuedWaitOf`). The successor's Resume continues the turn, and
   *  this wait with it, where a person's Resume would end the wait. A run
   *  that continues the turn with no Resume input, as a child's
   *  continuation does, opens it before its first request. Input that
   *  starts the turn first supersedes the cut and drops it. */
  readonly continuedWait?: RestoredAgentWait;
  /** Set for a maintenance runner (`AgentLoopMaintenance`). */
  readonly maintenance?: AgentLoopMaintenance;
  onCompactionContinuation?: () => void | Promise<void>;
  onTurnEnded?: (ctx: TurnEndedContext) => void | Promise<void>;
  /** Fires after each tool batch settles, before the loop drains queued input:
   *  a runtime notice enqueued here reaches the next request with the batch's results. */
  onToolBatchSettled?: () => void | Promise<void>;
  /** Fires after the loop installs its input wait reservation. Distinct from
   *  onTurnEnded, which fires for both the 'continue' and 'park' branches;
   *  this only fires when the loop is actually about to block. The bridge
   *  layers translate this into `agent.turn.parked` on the event bus. */
  onTurnParked?: (ctx: TurnParkedContext) => void | Promise<void>;
  /** Symmetric with onTurnParked: fires immediately after the input wait
   *  returns non-null input that the loop will consume. Bridge layers
   *  translate this into `agent.turn.resumed` on the event bus, which drives
   *  the idle → streaming transition on the entry. */
  onTurnResumed?: () => void;
  /** Brackets an account login wait outside the provider stream lifetime. */
  onLoginWait?: (waiting: boolean) => void;
  /** Fires when the loop consumes a queued/resumed message as a new logical
   *  model-input turn. Resume-seeded callers emit their own start event
   *  because the user message is already in priorMessages. */
  onLogicalTurnStarted?: (ctx: LogicalTurnStartedContext) => void;
}

export interface AgentLoopOptions {
  /** Stable model metadata and the fixed client used by direct loop callers.
   *  Runtime assembly replaces it at the wire boundary with the client pinned
   *  by `tools` for each request. */
  client: TurnModelClient;
  /** Profile captured with the initial runtime request. Direct loop callers omit it and resolve from `client`. */
  initialInteractionProfile?: ModelInteractionProfile;
  /** Attempt planned by the initial request admission. */
  initialPlannedAttempt?: ServingAttempt;
  /** One request-composition owner for modules, tools, prompt bytes, provider
   *  clients and planning, transformers, execution gates, and billing. */
  tools: RequestToolSurfaceOwner;
  /** Builds the request-stable prompt from the planned serving attempt and the
   *  one interaction profile captured for this request. */
  systemPrompt: SystemPromptTiers | ((attempt: ServingAttempt, profile: ModelInteractionProfile) => SystemPromptTiers | Promise<SystemPromptTiers>);
  /** The modules' standing-mode reminders for the next request, decided from the history (turn-reminders.ts). */
  turnReminders?: (messages: readonly ConversationMessage[]) => Promise<readonly ConversationMessage[]>;
  /** Literal headless prompts bypass model and provider guidance byte-for-byte. */
  literalSystemPrompt?: boolean;
  /** Holds the first request of this run behind a sibling that writes the
   *  same cached prompt prefix. Only the runtimes of agents of a workflow carry it
   *  (prompt-prefix-hold.ts). */
  promptPrefixHold?: PromptPrefixHold;
  /** `null` is a respawn wake: valid only with a `resume` seed, where the
   *  mailbox holds the input this life exists to drain. */
  instruction: string | null;
  /** Request-only context seeded by recovery. Applied throughout this logical turn. */
  initialRequestContext?: string;
  /** Directory this loop's tools execute in. */
  executionCwd: string;
  /** Runtime-owned advisory validator shared by every runner in this generation. */
  streamingEditValidation?: StreamingEditValidationService;
  /** Canonical directory that owns the project's durable state: memory, skill
   *  store, instructions, and the learning audits attributed to this project.
   *  Distinct from `executionCwd`, and never derived from it. */
  projectRoot: string;
  /** Startup-owned account root, passed unchanged to shell write policy. */
  userDataRoot: string;
  /** Canonical credential roots that linked descendants of a requested filesystem root cannot enter. */
  protectedTraversalRoots?: readonly string[];
  /** Successful manual skill loads effective for this runner. */
  effectiveBundledSkillIds?: ReadonlySet<string>;
  /** Validated handoff capture and its co-varying runtime behavior. */
  handoff?: {
    onContent: (content: HandoffContent) => void;
    readCommandEvidence?: ReadCommandEvidence;
    schema?: HandoffToolSchema;
  };
  signal?: AbortSignal;
  /** Run-scoped disposal signal. Unlike signal, this survives turn interrupt/ESC. */
  disposalSignal?: AbortSignal;
  /** The host that owns this loop's background work (see `background` in
   *  AgentOptions): its kill signal, its task registry, and the lifetime
   *  every background dispatch is admitted into. Absent when no host owns any:
   *  the loop then has no background dispatch surface. */
  background?: BackgroundExecutionOwner;
  onEvent: (event: StreamEvent) => void;
  onSystemMessage?: (message: string, level?: "info" | "error") => void;
  onNotice?: (operation: SessionNoticeOperation) => void;
  onNotification?: (episode: NotificationEpisodeInput) => void;
  onUserMessage?: (content: string | ContentBlock[], origin: UserMessageOrigin, identity?: Pick<ChatInput, "submissionIds" | "dispatchIds">) => void;
  onTurnAssistantMessage?: (content: ContentBlock[], entryId?: string) => void;
  inputSource?: InputSource;
  /** Injects the park clock. Returns cleanup for the single wait expiry. */
  scheduleWaitExpiry?: (seconds: number, expire: () => void) => () => void;
  /** Complete after the bounded run reaches idle, even when its input source can park. `seal` accepts the final
   *  reply as the result and returns false when input arrived first, so the loop takes that input instead. */
  completeOnIdle?: { readonly seal?: ((finalReply: string) => boolean) | undefined };
  /** Enable reply reminders for a human-facing loop; child replies go to their dispatcher. */
  humanFacing?: boolean;
  persistence: AgentLoopPersistence;
  seed: AgentLoopSeed;
  lifecycle?: AgentLoopLifecycle;
  /** Used for fixed-selection calls without a request role. */
  reasoningEffort?: () => Promise<ReasoningEffort | undefined>;
  cacheRetention?: CacheRetention;
  providerOptions?: ProviderRequestOptions;
  maxLLMCalls?: number;
  /** The model calls that earlier runs of this turn started. The loop's call
   *  count starts from them, so the budget trailer, the closure whitelist, and
   *  the hard cap read one count across the runs that recovery starts. */
  priorLLMCalls?: number;
  /** Counts the loop keeps for the run's completion record. */
  tally?: AgentRunTally;
  /** Stable provider session identity of this run: session headers, provider
   *  connection lifetime, and audit. Never a durable conversation or session
   *  identity, and never the prompt-cache key. */
  providerSessionKey: string;
  /** The prompt-cache group of every request of this run: the chat tree whose
   *  agents and side calls share a prefix (`StreamOptions.promptCacheKey`). */
  promptCacheKey: string;
  /** Durable Flywheel session identity when this run belongs to one. */
  sessionId?: string;
  /** Stable directory scope for saved tool output. */
  artifactScopeId: string;
  /** Stable scope for remote search result references. */
  retrievalSessionId: string;
  /** Session-scoped scratchpad directory (`<sessionDir>/scratch`). Threaded
   *  into the tool context and rendered into the system prompt; disposable
   *  agent workspace, never a read substrate. */
  scratchDir?: string;
  /** Scoped checkpoint authority, independent of the current conversation branch. */
  checkpoint?: import("../session/conversation-checkpoint.js").ConversationCheckpointOwner;
  /** The recorded brief of an unattended agent, which every reset opening
   *  restates (PI-AGENT-010). Read once per reset; absent or undefined omits it. */
  standingBrief?: () => Promise<string | undefined>;
  /** Launch authority handed to the tool context. See AgentOptions. */
  launcher?: LauncherScope;
  /** The runtimes of this runner's enabled modules, handed to the tool context. See ToolContext. */
  moduleRuntimes?: ModuleRuntimes;
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient;
  allowPersistentProcesses?: () => boolean | Promise<boolean>;
  afterToolCall?: AfterToolCallHook;
  /** Provider request audit boundary. Records the exact prompt, tool surface,
   *  model request, response id, and failure outcome for each streamed turn. */
  requestAudit?: ProviderRequestAuditWriter;
  /** In-memory request attribution registry. Admission consumes each identity once. */
  requestAttribution?: {
    resolve(requestId: string): ToolAttributionIdentity | undefined;
    retire(requestId: string): void;
  };
  sessionEventWriter?: SessionFactWriter;
  usageSettlement?: {
    readonly settlement: UsageSettlement;
    readonly profileId: string;
    readonly budgetStreamId: string;
    readonly identity: Parameters<UsageSettlement["begin"]>[0]["identity"];
    readonly workflowAttemptId?: string;
    readonly parentToolUseId?: string;
  };
  /** The shared runtime event store; tools writing non-session aggregates
   *  funnel through its single writer lane instead of opening a connection. */
  sessionEventStore?: AsyncEventStateReadSurface;
  sessionEventReader?: AsyncEventStateReadSurface;
  applyNestedStoredFact?: (event: StoredFact) => void | Promise<void>;
  /** Capability boundary handed to every tool call of this loop (ARCH-RUNTIME-066, ARCH-RUNTIME-068).
   *  Absent in a realm that owns no capability policy. */
  capabilityAccess?: CapabilityAccess;
  conversationId?: string;
  /** Tool-use id this loop's runner nests under; see ToolContext.parentToolUseId. */
  parentToolUseId?: string;
  /** Host-owned durability barrier: commit the pending turn to the branch. */
  flushCanonicalMessages?: (
    protectedToolUseIds?: ReadonlySet<string>,
    finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[],
  ) => Promise<void>;
  /** Wait until runtime display facts emitted before model-history settlement are durable. */
  awaitDurableFacts?: () => Promise<void>;
  waitForEventCapacity?: (signal?: AbortSignal) => void | Promise<void>;
  onConnectionState?: (state: ConnectionState) => void;
  currentTurn?: CurrentTurnInterruption;
}

/** Why the loop exited. Every return site states its own reason; nothing
 *  downstream reconstructs liveness from side-channel flags.
 *  - `completed`: the closure condition was satisfied (oneshot model yield,
 *    or a required handoff was written).
 *  - `budget_exhausted`: the hard LLM-call cap forced a final summary turn.
 *  - `context_overflow`: reactive overflow recovery was exhausted.
 *  - `aborted`: the durable runner signal fired (runner.abort / session end).
 *  - `interrupted`: the per-turn interrupt fired and the loop has no park
 *    destination (no inputSource), so it exited instead of waiting.
 *  - `input_closed`: the parked wait yielded null while the durable signal was
 *    still live. Input sources only resolve null on abort, so outside tests
 *    with hand-rolled sources this indicates a broken input source.
 */
export type AgentLoopTerminal =
  | { kind: "completed" }
  | { kind: "budget_exhausted" }
  | { kind: "context_overflow" }
  | { kind: "aborted" }
  | { kind: "interrupted" }
  | { kind: "input_closed" };
