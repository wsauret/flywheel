import type { AgentDefinition } from "../../../../infra/agent-definition.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../../infra/event-store-types.js"
import type { ModelFamily } from "../../../../infra/llm/model-family.js"
import type { ModelInfo, ModelsClient } from "../../../../infra/llm/models.js"
import type { ProviderRequestOptions } from "../../../../infra/llm/provider-options.js"
import type { ModuleId } from "../../../../protocol/module-ids.js"
import type { SkillRegistryRevision } from "../../../../workflows/skill-schema.js"
import type { Agent, AgentOptions, RunnableAgentOptions, RuntimeToolSurfaces } from "../../../agent-runtime/types.js"
import type { BackgroundWorkRegistry } from "../../../agent-runtime/background-work.js"
import type { ChildSlotRegistry } from "../../../agent-runtime/child-slot-registry.js"
import type { SubagentToolCallRecord } from "./work-log.js"
import type { SessionFactWriter } from "../../../session/session-fact-writer.js"
import type { PromptKind } from "../../../agent-runtime/system-prompt.js"
import type { BriefScope } from "../../../config/role-selection.js"
import type { RoleResolver } from "../../../config/roles.js"
import type { ChildSessionAuthority, ChildSessionConversation, ParentNotificationDelivery } from "../../../module-seams.js"
import type { DefinitionAvailabilitySnapshot } from "../../../app-service/definition-availability.js"
import type { ModuleRuntimeServices } from "../../../agent-runtime/module-runtime-services.js"

export interface SubagentDispatchDeps {
  userDataRoot: string
  accountHome: string
  agentRegistry: ReadonlyMap<string, AgentDefinition>
  capabilityRequirements: readonly ModuleId[]
  allowedSubagentTypes?: ReadonlySet<string>
  skills: SkillRegistryRevision
  /** Definition availability under the dispatcher's live selection. A fresh
   *  dispatch refuses a persona that is unavailable here, and the child's
   *  opening material renders against it (ARCH-CONTEXT-033). */
  definitionAvailability: DefinitionAvailabilitySnapshot
  /** The agent check of a child as its own first request plans its tools (`ModuleRuntimeServices.planChildCapabilities`).
   *  A fresh dispatch keeps only the declared tools that it answers yes to, and renders the child's task from it. */
  planChildCapabilities: ModuleRuntimeServices["planChildCapabilities"]
  modelFamily: ModelFamily
  availableModels?: ReadonlySet<string>
  modelInfos?: ReadonlyMap<string, ModelInfo>
  modelsClient?: ModelsClient
  parentModel: string
  parentEffort?: AgentOptions["effort"]
  parentProviderOptions?: ProviderRequestOptions
  parentPromptKind: PromptKind
  resolveRoles: RoleResolver
  briefScope?: BriefScope
  onRenderEvent: (event: import("../../../../infra/runtime-event-types.js").RuntimeEvent) => void
  onChildRenderEvent: (childSessionId: string, event: import("../../../../infra/runtime-event-types.js").RuntimeEvent) => void
  backgroundTasks: BackgroundWorkRegistry
  deliverParentNotification?: ParentNotificationDelivery
  failureSummarizerForChild?: (child: {
    readonly sessionId: string
    readonly conversationId: string
    readonly projectRoot: string
    readonly executionCwd: string
    readonly eventWriter: SessionFactWriter
    readonly reader: AsyncEventStateReadSurface
  }) => NonNullable<SubagentDispatchDeps["summarizeOnFailure"]>
  childSlots: ChildSlotRegistry
  sessionDir?: string
  sessionId: string
  providerSessionKey: string
  createRunner: (opts: RunnableAgentOptions) => Agent
  sessionEventWriter?: SessionFactWriter
  usageProfile?: AgentOptions["usageProfile"]
  authProfileId: string
  awaitDurableFacts?: () => Promise<void>
  waitForEventCapacity?: AgentOptions["waitForEventCapacity"]
  auditObserver?: RunnableAgentOptions["auditObserver"]
  usageObserver?: RunnableAgentOptions["usageObserver"]
  applyNestedStoredFact?: (event: StoredFact) => void | Promise<void>
  sessionEventStore?: AsyncEventStateReadSurface
  proactiveCompactionThreshold?: () => number
  captureRuntimeConfig: RunnableAgentOptions["captureRuntimeConfig"]
  captureProviderConnection?: import("../../../agent-runtime/factory.js").CaptureProviderConnection
  awaitModelAccessSettled: RunnableAgentOptions["awaitModelAccessSettled"]
  inheritableRuntimeSurfaces: RuntimeToolSurfaces
  moduleSelection: NonNullable<AgentOptions["moduleSelection"]>
  keepAliveIntervalMs?: number
  createChildConversation?: (id: string) => ChildSessionConversation
  subagentSessions: ChildSessionAuthority
  summarizeOnFailure?: (
    records: ReadonlyArray<SubagentToolCallRecord>,
    terminalError: string,
    signal?: AbortSignal,
  ) => Promise<string>
}
