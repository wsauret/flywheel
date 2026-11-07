import type { CapabilityAdmission, CapabilityGrant, CapabilityRequest, ModulePolicy } from "../../config/module-policy.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import type { ToolAction } from "../../../infra/workflow-types.js";
import type { SessionFactWriter } from "../../session/session-fact-writer.js";
import type { ToolOutcome } from "../../../infra/tool-outcome.js";
import type { BackgroundWorkRegistry, ToolCallIdentity } from "../background-work.js";
import type { LlmToolOutputPart } from "../../../infra/llm/tool-output-part-schema.js";
import type { ConversationMessage, ToolCall, ToolWirePresentation } from "../llm/types.js";
import type { FileReadLedger } from "./file-read-ledger.js";
import type { ContextAdmission } from "../compaction/compaction-policy.js";
import type { GitAiAttributionService, GitAiRequestRegistration } from "../git-ai-attribution-service.js";
import type { NestedToolDispatchBatch } from "./nested-tool-dispatch.js";
import type { ReadCommandEvidence } from "../../../workflows/output-contract/evidence.js";

import type { PersistentProcessClient } from "../../../infra/persistent-process-manager.js";
import type { BridgedPersistentProcessClient } from "../../../infra/persistent-process-bridge.js";
import type { ForegroundBashHoldController } from "../foreground-bash-hold.js";
import type { ShellRuntimeClient } from "./shell-runtime-types.js";
import type { ModuleRuntimes } from "../../../infra/module-runtime.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js";
import { canonicalModuleIds, MODULE_IDS, type ModuleId } from "../../../protocol/module-ids.js";
type ToolExecutionMode = "foreground" | "background";
type ToolTraceKind = "tool" | "subagent";

/** Closed tool authority for an execution. Absence retains ordinary selection. */
export type ToolProfile = "none";

/** Immutable provider-request identity copied into a call before tool effects start. */
export interface ToolAttributionIdentity extends GitAiRequestRegistration {
  readonly service: GitAiAttributionService;
  readonly repositoryRoot: string;
  readonly profileId: string;
  readonly enabled: true;
}


export interface RuntimeToolInput {
  [field: string]: unknown;
}



/** What the model reads when a call needs an optional capability the selection
 *  does not hold. One wording for every refusal of a disabled tool, wherever the
 *  refusal is decided. */
export function refuseDisabledToolCall(name: string, reason: string): string {
  return `${reason}. Do not call ${name} again in this session; continue without it.`;
}

const applyCapabilityGrant = Symbol("CapabilityAccess.applyGrant");
/** The capability boundary one model tool call passes (ARCH-RUNTIME-068). A tool call is
 *  either the bounded continuation of an operation that already holds a grant
 *  authorizing it, or a new optional operation that admits against current
 *  policy. A stale call the model kept from an earlier request is refused here. */
export interface CapabilityAccess {
  /** Grant of the admitted operation this call belongs to, when there is one. */
  readonly grant?: CapabilityGrant;
  /** Whether this context holds one capability right now. */
  available(capability: ModuleId): boolean;
  admit(request: CapabilityRequest): Promise<CapabilityAdmission>;
  /** Factory-owned operation. Structural implementations cannot mint wider access. */
  readonly [applyCapabilityGrant]?: (grant: CapabilityGrant) => CapabilityAccess;
}

/** The boundary a context that owns no capability policy holds: no optional
 * capability, and every admission refused. Absence of a policy is not
 * permission, so a realm wired without one runs core tools only. */
export const NO_CAPABILITY_ACCESS: CapabilityAccess = Object.freeze({
  available: () => false,
  admit: async (request: CapabilityRequest): Promise<CapabilityAdmission> => ({
    ok: false,
    missing: canonicalModuleIds(request.required),
    reason: `${request.operation} is unavailable: this context holds no capability policy`,
  }),
});


/** The capability boundary of work this policy admits. Every producer of a
 *  `CapabilityAccess` builds it here, so `available` and `admit` always read the
 *  same authority. */
export function capabilityAccessFor(
  capabilities: Pick<ModulePolicy, "admit" | "state">,
  grant?: CapabilityGrant,
  ceiling: readonly ModuleId[] = MODULE_IDS,
): CapabilityAccess {
  const boundedCeiling = canonicalModuleIds(ceiling);
  const createAccess = (activeGrant?: CapabilityGrant): CapabilityAccess => ({
    ...(activeGrant ? { grant: activeGrant } : {}),
    available: (capability) => boundedCeiling.includes(capability)
      && (grantCovers(activeGrant, [capability]) || capabilities.state().capabilities.includes(capability)),
    admit: async (request) => {
      const outsideCeiling = canonicalModuleIds(request.required).filter((capability) => !boundedCeiling.includes(capability));
      if (outsideCeiling.length > 0) {
        return { ok: false, missing: outsideCeiling, reason: `${request.operation} is unavailable: ${outsideCeiling.join(", ")} exceeds this host's capability ceiling` };
      }
      return await capabilities.admit(request);
    },
    [applyCapabilityGrant]: createAccess,
  });
  return createAccess(grant);
}

/** Applies a grant only through the opaque operation owned by the access factory. */
export function withCapabilityGrant(access: CapabilityAccess, grant: CapabilityGrant): CapabilityAccess {
  return access[applyCapabilityGrant]?.(grant) ?? access;
}

/** Whether a grant already authorizes this requirement, so the operation
 *  continues on it instead of admitting again. Only the requirement set the
 *  grant was admitted for is authorized: the selection it carries is evidence of
 *  the configuration that satisfied it, not a licence for unrelated work. */
export function grantCovers(grant: CapabilityGrant | undefined, required: readonly ModuleId[]): boolean {
  return grant !== undefined && required.every((capability) => grant.required.includes(capability));
}

export interface RuntimeToolExecution {
  mode: ToolExecutionMode;
  traceKind: ToolTraceKind;
  childHasOwnViewport?: boolean;
}

const DEFAULT_EXECUTION: RuntimeToolExecution = {
  mode: "foreground",
  traceKind: "tool",
};

export function runtimeToolExecution(tool: RuntimeTool | undefined): RuntimeToolExecution {
  return tool?.execution ?? DEFAULT_EXECUTION;
}

/** Identity pair of `context`'s originating tool call, for deferred facts
 *  (live output tails, background meta) that echo the input fact's identity. */
export function toolCallIdentity(context: ToolContext): ToolCallIdentity {
  return {
    ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
    ...(context.modelRequestId ? { modelRequestId: context.modelRequestId } : {}),
  };
}

/**
 * Runtime contract for a tool: input schema, prompt fields, execution
 * semantics, and execute handler. Display metadata lives in
 * `infra/tools/displays/<name>.ts`; it must not decide scheduling or trace
 * classification.
 */

export interface BoundedStringCodeModeOutput {
  readonly kind: "bounded-string";
  encode(result: ToolResult): { readonly outcome: ToolOutcome; readonly content: string };
}

/** Code-mode transport keeps text script-visible. The adapter relays image parts on the outer result. */
export const boundedStringCodeModeOutput: BoundedStringCodeModeOutput = Object.freeze({
  kind: "bounded-string",
  encode: (result: ToolResult) => ({
    outcome: result.outcome,
    content: typeof result.content === "string"
      ? result.content
      : result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
  }),
});

export interface RuntimeTool {
  name: string;
  action: ToolAction;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  /** Guidelines resolved while each request assembles its system prompt. */
  livePromptGuidelines?: () => readonly string[];
  promptExamples?: string;
  /** Provider-facing JSON schema. The root is always one `type: "object"`
   *  schema: providers reject a union root (`oneOf`, `anyOf`, `allOf`), so
   *  variants are one flat object with a discriminating enum field and the
   *  handler enforces per-variant requirements. */
  inputSchema: RuntimeToolInput;
  /** Optional schema for dispatch coercion and validation before execution gates.
   *  Use when executable inputs include fields omitted from the provider-facing schema. */
  inputValidationSchema?: RuntimeToolInput;
  /** Provider wire presentation when the tool is more than a JSON function, such as a grammar-constrained custom tool. */
  wire?: ToolWirePresentation;
  /** Script exposure is exclusive to a module's code-only tools, such as an external tool server's. Absence means provider-native only. */
  codeMode?: "exclusive";
  /** JSON-compatible transport required by every script-eligible tool. */
  codeModeOutput?: BoundedStringCodeModeOutput;
  /** Outer tools can bypass child admission because they own a nested batch. */
  gateAdmission?: "none";
  execution?: RuntimeToolExecution;
  /** Start only after the assistant tool-use message is durably acknowledged. */
  deferUntilAssistantCommitted?: true;
  /** Whether the normalized input can share the concurrency gate. Dynamic
   *  predicates are evaluated immediately before gate acquisition. */
  isConcurrencySafe: boolean | ((input: Readonly<RuntimeToolInput>) => boolean);
  /** Canonical mutation targets for path-scoped gate admission (ARCH-TOOLS-004): a
   *  not-safe call that declares its target paths may run alongside calls
   *  whose reserved paths do not overlap. Tools without a declarable target
   *  (bash) omit this and stay fully exclusive; returning [] (input carries
   *  no usable path) also falls back to exclusive. Implementations must
   *  canonicalize with canonicalMutationPath so the gate and the
   *  file-mutation queue agree on what "same file" means. */
  reservedPaths?: (input: Readonly<RuntimeToolInput>, executionCwd: string) => readonly string[];
  /** The tool's deterministic execution policy (ARCH-TOOLS-008). The
   *  dispatcher runs it on the validated, repaired input before concurrency,
   *  capability admission, and the module execution gate, so a refused call
   *  never reaches any of them. Returns the model-readable refusal, or
   *  undefined to admit; `execute` trusts that admission and repeats no check.
   *  Must not throw. */
  executionPolicy?: (input: Readonly<RuntimeToolInput>, context: ToolContext) => Promise<string | undefined>;
  /** One asynchronous preparation performed before path-gate admission and
   *  every execution gate. It may reserve the paths the input names, and it may
   *  repair the input: the repaired input replaces the model's for admission,
   *  gates, and execution alike, and `notice` leads the tool result so the model
   *  sees what changed. Input has shared conversions but is not yet structurally
   *  validated. Implementations must narrow each field before using it and must
   *  preserve fields they do not repair for final validation. */
  prepareAdmission?: (input: Readonly<RuntimeToolInput>, context: ToolAdmissionContext, signal?: AbortSignal) => Promise<{
    readonly reservedPaths?: readonly string[];
    readonly repair?: { readonly input: RuntimeToolInput; readonly notice: string };
  }>;
  /** Exempts this tool's results from the runtime's 30KB tool-result byte
   *  cap. Reserve for tools whose output is author-bounded definition text
   *  (e.g. briefs), where head+tail truncation would corrupt the
   *  content rather than trim noise. Unbounded-output tools stay capped. */
  uncappedOutput?: boolean;
  /** Tool owns its full model-visible input-validation conversation; the
   *  dispatcher skips central structural validation. Handoff needs this
   *  because collapsed-payload recovery must run before any schema check
   *  rejects the malformed shape. */
  validatesOwnInput?: true;
  /** Exempts this tool from the dispatcher's generic inactivity watchdog
   *  (`tool-dispatch.ts`). Reserve for tools with their own bounded timeout
   *  (bash escalates its own kill timer) or that legitimately block on
   *  something outside the process for longer than any tool call should
   *  otherwise take (ask_user waits on a human). Every other tool is
   *  presumed to complete quickly, so a hang is presumed a bug. */
  unboundedDuration?: true;
  execute: (input: RuntimeToolInput, context: ToolContext) => Promise<ToolResult>;
}

/** What a tool shows the model without the authority that runs it. A
 *  definition of this shape names no per-agent surface, so every agent of a
 *  chat tree advertises the same bytes for the tool whether it can run it. */
export type AdvertisedTool = Omit<RuntimeTool, "execute">;

/** A retained file that holds a tool's full payload, and the byte size and
 *  sha256 of that file's content. */
export interface RetainedFullContent {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ToolResult {
  // Convenience union; normalized to LlmToolOutputPart[] once at the producer boundary in agent-loop-tools.collectResults.
  content: string | LlmToolOutputPart[];
  outcome: ToolOutcome;
  /** Pre-drop payload for tools that emit a lossy view (search match-limit,
   *  bash compression, etc). When set, the agent-loop middleware saves this
   *  to the session breadcrumb dir and appends a single recovery notice to
   *  `content`. Tools must not write breadcrumbs themselves. */
  fullContent?: string;
  /** A file the tool already retained that holds the full payload, with
   *  its measured size and digest, for a lossy view whose payload is not in
   *  memory. The middleware names this file in its one recovery notice and
   *  writes no breadcrumb. Tools still never write breadcrumbs or notices. */
  retainedFullContent?: RetainedFullContent;
  /** Sanitized bounded subprocess output captured only for durable UI replay. */
  executionOutputTail?: string;
  /** Tool signals the agent loop should exit cleanly after this batch.
   *  The loop honors handoff as final on success; other terminating
   *  tools still require batch unanimity. A pending injected input
   *  still wins; see agent-loop.ts. */
  terminate?: boolean;
  /** Structured display metadata for the output layer. The edit tool uses
   *  this to carry `{ diff, filetype }`; other tools use it for their own
   *  display data (e.g. read's `{ displayContent }`). */
  details?: unknown;
  /** Content inserted as one user message after this tool batch settles and before the next model request. */
  nextUserContent?: LlmToolOutputPart[];
  /** When true, the agent loop emits `tool_result_ack` instead of
   *  `tool_result` to the render stream. The conversation still receives
   *  the full tool result, but the render layer keeps the agent block
   *  active until the real `tool_result` arrives later. */
  deferCompletion?: boolean;
  /** Graceful shutdown suspended this tool at a durable continuation point.
   *  The dispatcher must settle its Promise without emitting or committing
   *  any result from the abandoned in-memory turn. */
  suspendTurn?: true;
}

export interface ShellCommand {
  readonly command: string;
  readonly cwd: string;
}

export interface ToolNameMap {
  logical(presented: string): string;
  presented(logical: string): string;
}

/** The part of a tool context known before a call is admitted. */
export type ToolAdmissionContext = Pick<ToolContext, "executionCwd" | "protectedTraversalRoots" | "scratchDir"> & Partial<Pick<ToolContext, "projectRoot">>;

/** The charter policy in force for one tool call: read from the session's
 *  experiment projection at dispatch time, never captured at assembly. */
export interface ExperimentGuardSnapshot {
  readonly active: boolean;
  readonly initialized: boolean;
  readonly workDir: string;
  readonly protectedPaths: readonly string[];
  readonly sealedPaths: readonly string[];
}

export interface ToolContext {
  /** Directory this tool call executes in: the session's recorded execution
   *  directory, or a subdirectory a caller named. */
  executionCwd: string;
  /** The only way a tool starts a process: the runtime generation's launcher,
   *  which admits the payload only after the guardian owns its container.
   *  Absent for tool contexts with no launch surface, where a tool that needs
   *  one fails closed rather than spawning something nobody owns. */
  spawnOwned?: LauncherScope["spawnOwned"];
  /** Host-owned launch authority for commands explicitly admitted to outlive Flywheel. */
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient;
  /** Re-reads the effective host permission immediately before each persistent launch. */
  admitPersistentProcess?: () => boolean | Promise<boolean>;
  /** Canonical directory that owns the project's durable state. Every durable
   *  project write a tool makes - memory, the project skill store, learning
   *  audit and consent evidence - is scoped to this directory, never to
   *  `executionCwd`. */
  projectRoot: string;
  /** Startup-owned account directory. Never derived from the shell's HOME. */
  userDataRoot: string;
  /** Canonical credential roots rejected only when directory traversal discovers them through a linked child. */
  protectedTraversalRoots?: readonly string[];
  /** Canonical containing Git repository derived at startup. Tools and runtime
   * services consume this metadata and never repeat repository discovery. */
  canonicalRepositoryRoot?: string;
  /** Runtime-owned, repository-keyed Git AI attribution surface. */
  gitAiAttribution?: import("../git-ai-attribution-service.js").GitAiAttributionService;
  /** Request-captured attribution identity. It is non-durable and absent for ordinary tools. */
  attributionIdentity?: ToolAttributionIdentity;
  signal?: AbortSignal;
  /** Run-scoped disposal signal. Unlike signal, this survives turn interrupt/ESC. */
  disposalSignal?: AbortSignal;
  /** Background-work signal: session-scoped when the runner's caller supplies
   *  one, otherwise the run disposal signal. Governs work that outlives the
   *  turn, such as a backgrounded command's log tailer. */
  backgroundSignal?: AbortSignal;
  /** Host-generation shell runtime. Absent only in deliberately isolated test contexts. */
  shell?: ShellRuntimeClient;
  /** Session authority for foreground Bash calls that can transfer to managed background work. */
  foregroundBashHold?: ForegroundBashHoldController;
  /** The runtimes of this runner's enabled modules, read by execution gates
   *  through their typed handles. Absent, every gate sees no runtime. */
  moduleRuntimes?: ModuleRuntimes;
  /** Validated handoff capture and behavior. Present only when the handoff
   *  tool is available, so invalid partial configurations are unrepresentable. */
  handoff?: {
    onContent: (content: RuntimeToolInput) => void;
    readCommandEvidence?: ReadCommandEvidence;
  };
  /** The stream-start handoff decision, shared by top-level and nested calls. */
  refuseAfterHandoff?: (call: ToolCall) => ToolResult | undefined;
  /** Generic live execution-output channel. Tools may report ephemeral,
   *  accumulated, tail-capped output here while work is still running. */
  onExecutionOutput?: (text: string) => void;
  /** Execution-scoped nested dispatch factory. Present only while a foreground call owns the attempt gate. */
  createNestedToolDispatchBatch?: (options: {
    readonly tools: ReadonlyMap<string, RuntimeTool>;
    readonly parentToolUseId: string;
    readonly modelRequestId?: string;
    readonly onNestedStart?: (breadcrumb: string) => void;
  }) => NestedToolDispatchBatch;
  /** Session-scoped scratchpad directory (`<sessionDir>/scratch`) for agent
   *  scratch scripts and temp files. Disposable workspace deleted with the
   *  session; nothing projects from it. The bash tool creates it lazily (and
   *  installs the `bun` shim in binary mode) before spawning. */
  scratchDir?: string;
  /** Standalone-valid fork source. Durable parents refresh their committed tree,
   *  exclude an open suffix exchange, and reject malformed retained history.
   *  Ephemeral parents heal their in-memory history. Provider reasoning is
   *  stripped from both forms before a child seed is written. */
  snapshotConversation?: () => Promise<ConversationMessage[]>;
  /** The loop's one context admission budget. Dispatch tools size and charge
   *  the results they deliver against it at the moment a child completes. */
  contextAdmission?: ContextAdmission;
  /** Logical names of the tools this agent may call, for dispatch inheritance and validation. */
  availableTools?: ReadonlySet<string>;
  /** The agent check of the request in flight (ARCH-CONTEXT-033), for text that only this agent reads, such as a
   *  tool result or a skill load. Absent where no request surface exists. */
  capabilities?: CapabilityCheck;
  /** Maps between the names this request's surface advertised to the provider and the logical
   *  registration ids grants and policy use. A logical id with no presented tool maps to itself. */
  toolNames?: ToolNameMap;
  /** What this loop has read of each file, so an edit can warn about stale or partial evidence. In memory only. */
  readLedger?: FileReadLedger;
  /** Successful skill loads effective for this runner. Read-only to tool policy. */
  effectiveBundledSkillIds?: ReadonlySet<string>;
  /** Set per-call by executePreparedTool; the tool_use block's ID from the LLM response. */
  toolUseId?: string;
  /** Provider request that emitted the tool_use block. */
  modelRequestId?: string;
  /** Tool-use id this runner nests under (constant per runner; absent at top
   *  level). With `modelRequestId` it is the identity pair every durable fact
   *  of this call must echo, or startup replay rejects the ledger. */
  parentToolUseId?: string;
  /** Stable directory scope for dropped output under `.flywheel/agent-outputs/`. */
  artifactScopeId: string;
  /** Stable scope for remote search result references. */
  retrievalSessionId: string;
  /** Durable Flywheel session identity when this tool call belongs to one. */
  sessionId?: string;
  /** Durable conversation-tree identity. */
  conversationId?: string;
  /** Commits all canonical messages pushed so far to the conversation tree. */
  flushCanonicalMessages?: (protectedToolUseIds?: ReadonlySet<string>) => Promise<void>;
  /** Background-task registry for deferring tools such as subagent. The
   *  workflow variant additionally gates handoff on pending subagent
   *  notification batches via the `kind === "workflow"` discriminant. */
  backgroundTasks?: BackgroundWorkRegistry;
  /** Durable session event writer used for file lineage and other typed facts. */
  sessionEventWriter?: SessionFactWriter;
  /** Read-only shared runtime state. Non-session writes use module-owned
   *  authorities bound to the process's shared writer lane. */
  sessionEventStore?: AsyncEventStateReadSurface;
  /** Exact asynchronous state reads for interactive tool observations. */
  projectionReader?: AsyncEventStateReadSurface;
  /** Applies a fact only after its durable event commits. Restart applies the same stored event. */
  applyNestedStoredFact?: (event: import("../../../infra/event-store-types.js").StoredFact) => void | Promise<void>;
  /** Capability boundary for this call (see CapabilityAccess). Present wherever
   *  a host owns a capability policy; a realm that owns none wires none, and a
   *  tool that needs no optional capability never consults it. */
  capabilityAccess?: CapabilityAccess;
  /** The wake hop of the turn this call runs in: the number of steps in the
   *  chain of session messages that led to it (`hopAfter`). A message this
   *  turn sends carries it. Absent outside a loop, where every turn is hop 0. */
  turnHop?: () => number;
  /** The loop's model-visible history at the moment of the call, for a tool
   *  that reads what this session already read. */
  conversationHistory?: () => readonly ConversationMessage[];
  /** True when the assistant turn that issued this call committed user-visible
   *  text (a non-empty text block). Read after the assistant-commit gate by
   *  tools that must not surface UI with no visible context (ask_user).
   *  Absent in tool contexts without a turn commit path. */
  turnHasVisibleText?: () => boolean;
}

export interface BashOperations {
  writeScript(path: string, content: string): Promise<number>;
  deleteScript(path: string): Promise<void>;
  ensureDir(path: string): void;
  writeExecutable(path: string, content: string): Promise<void>;
}
