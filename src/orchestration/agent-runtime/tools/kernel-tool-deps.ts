/**
 * The kernel half of what a tool factory receives: the per-request facts and
 * host authorities every module may read. Nothing here is owned by a module;
 * a module reaches its own per-runner state through its runtime handle.
 */

import type { AgentDefinition } from "../../../infra/agent-definition.js";
import type { ModelFamily } from "../../../infra/llm/model-family.js";
import type { ProviderRequestOptions } from "../../../infra/llm/provider-options.js";
import type { SkillRegistryRevision, SkillDefinition } from "../../../workflows/skill-schema.js";
import type { AskUserController } from "../../runner/ask-user-controller.js";
import type { HandoffToolSchema } from "../../workflow-host/handoff-tool-schema.js";
import type { RecallPort } from "../../../protocol/conversation-recall.js"
import type { BackgroundWorkRegistry } from "../background-work.js";
import type { ForegroundBashHoldController } from "../foreground-bash-hold.js";
import type { ExternalSkillChildGrant } from "./skill.js";
import type { CapabilityAccess } from "./types.js";
import type { FirstPartyModuleComposition } from "../../modules.js";
import type { RuntimeConfigRequestCapture } from "../request-config.js";
import type { AgentPurpose } from "../types.js";
import type { ModelInteractionProfile } from "../model-interaction-profile.js";
import type { SessionMessaging } from "../../session/session-messaging.js";
import type { CaptureProviderConnection } from "../factory.js";
import type { ConversationCheckpointOwner } from "../../session/conversation-checkpoint.js";

/** The model one request is served with. Per request, because the provider
 *  chain that serves a request is resolved per request. */
export interface ServingModel {
  readonly model: string;
  readonly modelFamily: ModelFamily;
  readonly availableModels?: ReadonlySet<string>;
  readonly effort?: string;
  readonly providerOptions?: ProviderRequestOptions;
}

export interface KernelToolDeps {
  /** Startup-selected account data root (ARCH-DIRECTORIES-001). The account-global skill
   *  store every skill surface of this turn resolves against lives under it. */
  readonly userDataRoot: string;
  /** Fresh session-profile eligibility for read-only model inspection, never the request's pinned capture. */
  readonly captureProviderConnection?: CaptureProviderConnection;
  readonly checkpoint?: ConversationCheckpointOwner;
  readonly handoff?: { readonly schema?: HandoffToolSchema };
  readonly askUser?: AskUserController;
  readonly recall?: RecallPort;
  /** The project's session messaging authority behind `message_session`
   *  and `list_sessions`. */
  readonly sessions?: SessionMessaging;
  /** Session-scoped authority for targeted background cancellation. */
  readonly backgroundTasks?: BackgroundWorkRegistry;
  /** Session-scoped authority for foreground commands transferred to managed work. */
  readonly foregroundBashHold?: ForegroundBashHoldController;
  /** Captured cap for a foreground Bash call before managed transfer. */
  readonly foregroundBashHoldSeconds?: number;
  /** Effective host permission for unmanaged processes, read once per request. */
  readonly persistentProcesses?: boolean;
  /** Whether a writing agent's shell refuses recognized writes outside the
   *  project (PI-AGENT-068). A tree-hosted request reads its tree's capture,
   *  so every agent of the tree advertises the same shell bytes. */
  readonly shellWriteGuard: boolean;
  /** The request-pinned file edit grammar of the serving model. */
  readonly fileEditContract?: ModelInteractionProfile["fileEditContract"];
  /** Capability boundary of the request being planned (ARCH-TOOLS-002). A tool whose
   *  required capabilities this context does not hold is not advertised, and
   *  its omission names policy. */
  readonly capabilities: Pick<CapabilityAccess, "available">;
  /** The skill revision this request advertises and executes. Read once when
   *  the request is planned, so the catalog and the tool agree. */
  readonly skills?: SkillRegistryRevision;
  /** Records successful skill body loads. */
  readonly onSkillLoad?: (skill: SkillDefinition) => void | Promise<void>;
  /** Attempt-bounded captured external child package authority. */
  readonly externalSkillChildGrant?: ExternalSkillChildGrant;
  /** Immutable module composition that admitted this request. */
  readonly moduleSnapshot: FirstPartyModuleComposition;
  /** Next-request policy captured at the same admission boundary as tools and providers. */
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  readonly purpose: AgentPurpose;
  readonly servingModel: ServingModel;
  /** The agent's definition marks it read-only: its shell tool refuses a
   *  command that writes a project file. */
  readonly readOnly?: boolean;
  /** The persona registry this runner dispatches from, and the agent types its
   *  grant allows; an absent grant allows every type. */
  readonly personas?: ReadonlyMap<string, AgentDefinition>;
  readonly allowedSubagentTypes?: ReadonlySet<string>;
  /** The request is served by the one agent host of its chat tree, whose key
   *  holds the tool list byte for byte. A tool whose per-agent surface is
   *  missing stays advertised and its call is refused, so every agent of the
   *  tree sends the same tool list. Absent or false: such a tool is omitted,
   *  as the chat's own engine needs no shared list. */
  readonly treeHosted?: boolean;
  /** The runtime has no client that reviews file changes, so its shell
   *  offers no mutating declaration (PI-AGENT-119). */
  readonly headless?: true;
}
