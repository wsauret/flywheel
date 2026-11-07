import * as os from "node:os";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import * as path from "node:path";

import type { SubagentDispatchDeps } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-deps.js";
import type { ConversationMessage, ModelClient } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import type { AgentFailureReason, AgentRunResult, Agent, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import { resolveSessionRoles } from "../../../../../src/orchestration/config/session-role-resolver.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";
import { createChildSlotRegistry } from "../../../../../src/orchestration/agent-runtime/child-slot-registry.js";
import { fixedAvailability, repoDefinitions } from "../../../../helpers/project-definitions.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { capabilityAccessFor, type CapabilityAccess } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { CapabilityAdmission, CapabilityGrant, CapabilityRequest } from "../../../../../src/orchestration/config/module-policy.js";
import type { ModuleId } from "../../../../../src/orchestration/modules.js";
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { newTestRunner } from "../../../../helpers/agent-runner.js";
import type { SummarizeSubagentWorkInput } from "../../../../../src/orchestration/modules/subagents/execution/summarize-work.js";
import type { AsyncEventStateReadSurface } from "../../../../../src/infra/event-store-types.js";
import type { ConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import type { ChildSessionAuthority } from "../../../../../src/orchestration/module-seams.js";
import { parseSubagentRunFact } from "../../../../../src/orchestration/modules/subagents/facts.js";
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js";
import { createConversationTreeProjection } from "../../../../../src/orchestration/session/conversation/conversation-projection.js";
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js";
import { roleCapture } from "../../../../helpers/role-capture.js";
import { canonicalModelId } from "../../../../../src/infra/llm/model-id.js";
import { Schema } from "effect";
import { EffortSchema } from "../../../../../src/infra/workflow-types.js";
import { createEmit, EventBus } from "../../../../../src/infra/event-bus.js";
import { subscribeSessionRuntimeFacts } from "../../../../../src/orchestration/session/create-session-infra.js";
import { agentCapabilityCheck } from "../../../../../src/orchestration/agent-runtime/capability-checks.js";

interface UnknownRecord { [key: string]: unknown }
let nextTestChildId = 0;

export function buildRegistry(): Map<string, AgentDefinition> {
  return new Map<string, AgentDefinition>([
    ["explorer", {
      kind: "persona",
      name: "explorer",
      description: "Fast read-only codebase investigation.",
      role: "explorer",
      tools: ["read", "search", "list", "bash", "code", "web"],
      maxTurns: 30,
      systemPrompt: "You are a focused codebase investigator.",
    }],
    ["implementer", {
      kind: "persona",
      name: "implementer",
      description: "General-purpose implementation.",
      role: "implementer",
      tools: ["read", "search", "list", "bash", "edit", "write"],
      maxTurns: 100,
      systemPrompt: "You are a task execution agent.",
    }],
  ]);
}

export const TEST_RATIONALE =
  "test fixture: dispatch rationale long enough to pass the 30-char minimum";

export interface SubagentContext {
  executionCwd: string;
  projectRoot: string;
  artifactScopeId: string;
  conversationId?: string;
  signal?: AbortSignal;
  toolUseId?: string;
  availableTools?: ReadonlySet<string>;
  snapshotConversation?: () => Promise<ConversationMessage[]>;
  capabilityAccess?: CapabilityAccess;
}

/** A capability boundary that records every admission it was asked for. `admit`
 *  answers each request in turn, so a case can admit one dispatch and then
 *  refuse everything after it. */
export function makeCapabilityAccess(answers: {
  readonly grant?: CapabilityGrant;
  readonly admit?: (request: CapabilityRequest) => CapabilityAdmission;
}): CapabilityAccess & { readonly requests: CapabilityRequest[] } {
  const requests: CapabilityRequest[] = [];
  const access = capabilityAccessFor({
    state: () => ({ moduleIds: [], capabilities: [], requireWorkflowConfirmation: true, workflowsMode: "off", identity: "test" }),
    admit: async (request) => {
      requests.push(request);
      if (!answers.admit) throw new Error("admit was called with no answer configured");
      return answers.admit(request);
    },
  }, answers.grant);
  return Object.assign(access, { requests });
}

export function refusedAdmission(reason: string): CapabilityAdmission {
  return { ok: false, missing: ["subagents"], reason };
}

/** A grant authorizing one dispatch, carrying `capabilities` as the evidence of
 *  the selection that satisfied it. */
export function grantOf(capabilities: readonly ModuleId[]): CapabilityGrant {
  return {
    operation: "the subagent tool",
    required: ["subagents"],
    moduleIds: capabilities,
    capabilities,
    requireWorkflowConfirmation: true,
    workflowsMode: "off",
    identity: `${capabilities.join("+")}|confirm|`,
  };
}

export function makeContext(overrides?: Partial<SubagentContext>): SubagentContext {
  return {
    executionCwd: os.tmpdir(),
    projectRoot: os.tmpdir(),
    artifactScopeId: "test-session",
    toolUseId: "test-tool-use",
    conversationId: "test-parent-conversation",
    // A production dispatch always carries the boundary it was admitted on; a
    // case about refusal states its own, or none.
    capabilityAccess: makeCapabilityAccess({ grant: grantOf(["subagents"]) }),
    ...overrides,
  };
}

export interface MockRunnerCall {
  options: AgentOptions;
}

export async function runnerEffort(options: AgentOptions | undefined): Promise<string | undefined> {
  return typeof options?.effort === "function" ? options.effort() : options?.effort;
}

interface MockRunnerFactoryOptions {
  finalText?: string;
  /** The run ends with this failure instead of completing. */
  failure?: AgentFailureReason;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  emitToolResult?: { toolUseId: string; content: string };
  capturedHandoff?: UnknownRecord;
}

export function makeMockRunnerFactory(opts?: MockRunnerFactoryOptions) {
  const calls: MockRunnerCall[] = [];

  const factory = (options: AgentOptions): Agent => {
    calls.push({ options });

    const parentToolUseId = options.purpose.kind === "subagent" ? options.purpose.parentToolUseId : undefined;

    const { promise, resolve, reject } = Promise.withResolvers<AgentRunResult>();

    return {
      send(_text: string): void {
        setTimeout(() => runMockRunnerScript(opts, options, parentToolUseId, resolve, reject), 0);
      },
      end() {},
      abort() {},
      done: promise,
    };
  };

  return { factory, calls };
}

function runMockRunnerScript(
  opts: MockRunnerFactoryOptions | undefined,
  options: AgentOptions,
  parentToolUseId: string | undefined,
  resolve: (result: AgentRunResult) => void,
  reject: PromiseWithResolvers<AgentRunResult>["reject"],
): void {
  try {
    if (opts?.failure) {
      resolve({ servedRequests: 0, durationMs: 1, terminal: opts.failure });
      return;
    }
    if (opts?.capturedHandoff) options.runtimeSurfaces?.handoff?.onContent(opts.capturedHandoff);
    emitMockToolResult(opts, options, parentToolUseId);
    emitMockAssistantText(opts, options, parentToolUseId);
    options.onEvent(createRuntimeEvent("model.turn.completed", {
      type: "model.turn.completed",
      subtype: "success",
      session_id: "agent-mock",
      total_cost_usd: opts?.totalCostUsd ?? 0.001,
      usage: {
        input_tokens: opts?.inputTokens ?? 100,
        output_tokens: opts?.outputTokens ?? 50,
      },
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }));
    resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-mock", terminal: { kind: "completed" } });
  } catch (err) {
    reject(err);
  }
}

function emitMockToolResult(
  opts: MockRunnerFactoryOptions | undefined,
  options: AgentOptions,
  parentToolUseId: string | undefined,
): void {
  if (!opts?.emitToolResult) return;
  options.onEvent(createRuntimeEvent("tool.result.recorded", {
    type: "tool.result.recorded",
    tool_use_id: opts.emitToolResult.toolUseId,
    content: [{ type: "text", text: opts.emitToolResult.content }],
    is_error: false,
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
  }));
}

function emitMockAssistantText(
  opts: MockRunnerFactoryOptions | undefined,
  options: AgentOptions,
  parentToolUseId: string | undefined,
): void {
  if (!opts?.finalText) return;
  options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
    type: "model.assistant_message.recorded",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: {
      content: [{ type: "text", text: opts.finalText }],
      usage: { input_tokens: opts.inputTokens ?? 100 },
    },
  }));
}

/** The child's task: the runtime-produced turn that follows its assignment. */
export function childTask(options: AgentOptions): string {
  if (options.conversation.kind !== "durable-tree") throw new Error("expected a durable child conversation");
  const task = options.conversation.priorMessages.findLast((message) => message.kind === "user" && message.origin === "system");
  if (task?.kind !== "user" || typeof task.content !== "string") throw new Error("the child has no task turn");
  return task.content;
}

/** The registries of the dispatch deps that this file made since the last
 *  settlement. A dispatched child runs past the end of the test that started
 *  it, and its stall watchdog and keep-alive timers live until it settles. */
const dispatchRegistries = new Set<SubagentDispatchDeps["backgroundTasks"]>();

/** Ends every child that the deps of the finished test dispatched, and waits
 *  for each to settle, so that no child of one test still holds timers while
 *  the next test runs. A file that dispatches without awaiting the child calls
 *  it after each test. */
export async function settleDispatchedWork(): Promise<void> {
  const registries = [...dispatchRegistries];
  dispatchRegistries.clear();
  await Promise.all(registries.map((registry) => registry.terminateAll()));
}

export function makeDeps(overrides?: Partial<SubagentDispatchDeps>): SubagentDispatchDeps {
  const { userDataRoot, accountHome } = testDirectories(os.tmpdir());
  const deps: SubagentDispatchDeps = {
    userDataRoot,
    accountHome,
    agentRegistry: buildRegistry(),
    capabilityRequirements: ["subagents"],
    skills: repoDefinitions().skills(),
    // The dispatcher's live availability follows the definitions and the
    // selection that a test overrides.
    definitionAvailability: fixedAvailability(
      { skills: overrides?.skills ?? repoDefinitions().skills(), personas: overrides?.agentRegistry ?? buildRegistry() },
      (overrides?.moduleSelection ?? composeFirstPartyModules)().enabledModuleIds,
    ),
    modelFamily: "anthropic",
    availableModels: new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]),
    modelsClient: fakeModelsClient,
    parentModel: "claude-opus-4-7",
    parentPromptKind: "chat",
    providerSessionKey: "test-parent",
    authProfileId: "default",
    captureRuntimeConfig: testRuntimeConfigCapture,
    awaitModelAccessSettled: async () => {},
    captureProviderConnection: async () => {
      const roles = await deps.resolveRoles();
      return roleCapture([...new Set([...fakeModelsClient.modelInfos.keys(), canonicalModelId(deps.parentModel), ...[...roles.values()].map((role) => canonicalModelId(role.model))])], Object.fromEntries([...roles].map(([id, role]) => [
        id, { model: role.model, effort: Schema.decodeUnknownSync(EffortSchema)(role.effort), ...(role.providerOptions ? { provider_options: role.providerOptions } : {}) },
      ])));
    },
    resolveRoles: async () => new Map([
      ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium" }],
      ["implementer", { roleId: "implementer", model: "claude-opus-4-6", effort: "high" }],
    ]),
    onRenderEvent: () => {},
    onChildRenderEvent: () => {},
    backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }),
    childSlots: createChildSlotRegistry(),
    sessionId: "test-session",
    sessionDir: path.join(os.tmpdir(), `subagent-test-${Date.now()}`),
    inheritableRuntimeSurfaces: {},
    moduleSelection: () => composeFirstPartyModules(),
    createRunner: () => { throw new Error("createRunner not provided in test deps"); },
    // A child's plan here lets it call every tool of its grant, under the dispatcher's live availability.
    planChildCapabilities: async (child) => agentCapabilityCheck(new Set(child.toolGrant), deps.definitionAvailability),
    subagentSessions: testSubagentSessionAuthority(() => deps),
    ...overrides,
  };
  deps.onChildRenderEvent = overrides?.onChildRenderEvent ?? ((_childSessionId, event) => deps.onRenderEvent(event));
  dispatchRegistries.add(deps.backgroundTasks);
  return deps;
}

function testSubagentSessionAuthority(getDeps: () => SubagentDispatchDeps): ChildSessionAuthority {
  return {
    resolveRoles: () => getDeps().resolveRoles(),
    allocateId: () => `test-child-${++nextTestChildId}`,
    childDepth: async () => 1,
    reconcileParentCompletion: (_parentSessionId, deliverNotification) => {
      setTimeout(() => {
        void deliverNotification?.({ text: "" })
      }, 0)
    },
    settleReconciliation: async () => {},
    registerLiveControl: () => () => {},
    settleUnreadMessages: async (settlement) => settlement.end(undefined),
    deactivate: async () => {},
    publishNewAttempt: async () => { throw new Error("new attempt not available in fixture"); },
    prepareResume: async () => ({ ok: false, error: "not eligible in fixture" }),
    publishResume: async () => { throw new Error("resume not available in fixture"); },
    publish: async (input) => {
      const deps = getDeps();
      const eventWriter = deps.sessionEventWriter ?? noopSessionFactWriter();
      const provided = deps.createChildConversation?.(input.childConversationId)
      const memory = memoryConversation()
      const conversation = {
        ...memory,
        ...provided,
        captureCommittedForkMessages: async () => [...await (provided ?? memory).captureCommittedForkMessages()],
        recordCompaction: async (compaction: Parameters<ConversationTreeWriterController["recordCompaction"]>[0]) => {
          const result = await (provided ?? memory).recordCompaction(compaction)
          return result === null ? null : { messages: [...result.messages], entryId: "fixture-compaction", tokensAfter: 0 }
        },
      }
      if ((await conversation.buildContext()).messages.length === 0) {
        conversation.beginTurn()
        for (const message of input.forkHistory ?? []) await conversation.recordCanonicalMessage(message)
        await conversation.recordCanonicalMessage({ kind: "user", content: input.assignment })
        await conversation.endTurn()
      }
      for (const fact of [input.runBinding, input.promptFact]) {
        await eventWriter.record(parseSubagentRunFact({
          type: fact.type,
          version: fact.version,
          actor: fact.actor,
          payload: fact.payload,
        }));
      }
      const eventStore = deps.sessionEventStore ?? asAsyncEventReadSurface({
        read: () => [],
        readTolerant: () => [],
        readLatestPayloadByAggregateAndType: () => null,
        readLatestByAggregateAndTypes: () => [],
        readInFlight: () => [],
        sessionsWithInFlight: () => [],
        hasInFlightProfile: () => false,
        currentPosition: () => 0,
        countByAggregate: () => 0,
        aggregateSeq: () => 0,
        toolContent: { resolve: () => null },
      });
      const bus = new EventBus();
      const emit = createEmit(bus);
      const facts = subscribeSessionRuntimeFacts(bus, {
        sessionId: input.childSessionId, sessionEventWriter: eventWriter, requireWriterBarrier: false,
      });
      return {
        emit,
        resolveRoles: async (capture) => {
          const inherited = await deps.resolveRoles(capture);
          const connection = capture ?? await deps.captureProviderConnection?.();
          if (!connection) throw new Error("The child fixture needs a profile capture");
          const assigned = await resolveSessionRoles({ defaults: {}, overrides: input.initialRoles }, connection, deps.userDataRoot);
          return new Map([...inherited, ...[...assigned].filter(([id]) => id in input.initialRoles)]);
        },
        sessionId: input.childSessionId,
        conversationId: input.childConversationId,
        sessionDir: deps.sessionDir ?? os.tmpdir(),
        eventStore,
        projectionReader: eventStore,
        eventWriter,
        conversation,
        onEvent: (event) => emit(event.type, {
          sessionId: input.childSessionId,
          data: event.type === "budget.stream.completed" ? event.data : { ...event.data, parent_tool_use_id: undefined },
        }),
        waitForEventCapacity: (signal) => bus.waitForCapacity(signal),
        awaitDurableFacts: () => facts.awaitDurableFacts(),
        failBeforeStart: async (error) => { throw error; },
        settle: async () => {
          try { await facts.awaitDurableFacts(); }
          finally {
            facts.unsubscribe();
            try { await bus.dispose(); }
            finally { await conversation.dispose(); }
          }
        },
      };
    },
  };
}

function memoryConversation(): ConversationTreeWriterController {
  const messages: ConversationMessage[] = [];
  const keys = new Set<string>();
  return {
    commitUserTurn: async () => null,
    recordedPersonMessage: async () => undefined,
    reserveMessageId: async () => crypto.randomUUID(),
    releaseMessageId() {},
    commitQueuedUserInput: async () => "committed",
    acceptRetainedOperation: async () => {},
    commitSystemTurn: async (text, key) => {
      if (key !== undefined && keys.has(key)) return key;
      if (key !== undefined) keys.add(key);
      messages.push({ kind: "user", content: text, origin: "system" });
      return key ?? null;
    },
    commitBackgroundNotification: async () => null,
    commitSystemMessage: async () => null,
    commitTurnEnd: async () => ({ kind: "user", content: "interrupted", origin: "system" }),
    beginTurn: () => {},
    endTurn: async () => {},
    recordCanonicalMessage: async (message) => { messages.push(message); },
    suspendPending: () => {},
    settleSuspendedTurn: async () => {},
    holdQueuedUserInput: async () => null,
    commitHeldMessage: async () => null,
    holdBackgroundNotification: async () => ({ key: "test", text: "" }),
    waitForBackgroundNotification: async () => {},
    holdsBackgroundNotification: () => false,
    dropQueuedUserInputs: async () => {},
    flushSavePoint: async () => {},
    buildContext: async () => ({ messages: [...messages] }),
    captureCommittedForkMessages: async () => [...messages],
    captureRawLiveMessages: async () => [...messages],
    recordCompaction: async () => null,
    getLeafId: async () => null,
    // The fake stores nothing, so its durable tree is empty.
    getState: () => createConversationTreeProjection(asAsyncEventReadSurface(inMemoryEventReader([])), "memory").replay(),
    recall: async () => ({ hits: [] }),
    dispose: async () => {},
  };
}

function noopSessionFactWriter(): SessionFactWriter {
  return {
    record: async () => null,
    recordBatch: async () => null,
    recordGuarded: async () => null,
    transaction: async (fn) => { fn(); },
    dispose: () => {},
  };
}

export function createNotificationCapture() {
  let latest = "";
  const next = Promise.withResolvers<string>();
  return {
    backgroundTasks: createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => {
        latest = text;
        next.resolve(text);
      },
    }),
    next: next.promise,
    read: () => latest,
  };
}

/** A failure summary whose side call runs through the real runtime against
 *  the client that `client` returns, with the child's request evidence in
 *  `store`. `runners` holds every runner the summary starts. */
export function failureSummaryInput(
  store: { sessionEventReader: AsyncEventStateReadSurface; sessionEventWriter: SessionFactWriter },
  client: () => Promise<ModelClient>,
  overrides: Partial<SummarizeSubagentWorkInput> = {},
): SummarizeSubagentWorkInput & { runners: Agent[] } {
  const runners: Agent[] = [];
  return {
    records: ["a.ts", "b.ts", "c.ts"].map((file) => ({ toolName: "read", input: { path: file }, status: "done" })),
    terminalError: "context_overflow",
    createRunner: (options) => {
      const runner = newTestRunner({ ...options, agentsMd: "", model: "summary-model" }, client);
      runners.push(runner);
      return runner;
    },
    runnerOptions: async () => ({
      projectRoot: "/scratch/project", executionCwd: "/scratch/child", userDataRoot: "/scratch/user", accountHome: "/scratch/home",
      moduleSelection: testCapabilityModules, captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
      runtimeSurfaces: {}, memorySnapshot: null, treeRootSessionId: "root-chat",
    }),
    child: { sessionId: "child", conversationId: "child-conversation", writer: store.sessionEventWriter, reader: store.sessionEventReader },
    runners,
    ...overrides,
  };
}
