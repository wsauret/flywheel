import type { AuthContext } from "../../infra/auth/auth-context.js";
import type { FirstPartyModuleSnapshot } from "../modules.js";
import type { KeyResolver } from "../../infra/auth/resolve-key.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { ModelListingClient } from "../../infra/llm/model-listing.js";
import type { ModelInfo, ModelsClient } from "../../infra/llm/models.js";
import type { ResolvedProviderModels } from "../../infra/llm/provider-model-preferences.js";
import type { AccessProviderId } from "../../infra/llm/access-provider.js";
import type { PickerModelEligibility } from "./provider-model-eligibility.js";
import type { ConfigValidity } from "./writer.js";
import type { FlywheelConfig } from "./schema.js";
import type { ModelOptionProvider, ModelSelectionSlot } from "../../protocol/model-assignment-protocol-types.js";
import type { CatalogDataUse } from "../../infra/llm/model-id.js";
import type { RoleAssignmentSnapshot } from "../session/schemas.js";
import type { AgentPersonaRoles } from "./role-selection.js";

/** Exact provider route selected once for one canonical picker model query. */
export type SelectedModelRoute =
  | {
      readonly wireModelId: string;
      readonly providerHint: string;
      readonly dataUse: CatalogDataUse;
      readonly providers: readonly ModelOptionProvider[];
      readonly metadata?: ModelInfo;
      readonly reason?: never;
    }
  | {
      readonly wireModelId?: never;
      readonly providerHint?: never;
      readonly dataUse?: never;
      readonly providers?: never;
      readonly reason: string;
    };

/** Injection surface shared by model-selection and model-assignment entry points. */
export interface ModelConfigDeps {
  /** Startup-selected account data root every account-global path derives
   *  from (ARCH-DIRECTORIES-002): the global config, the credential directory, and the
   *  models.dev snapshot. */
  readonly userDataRoot: string;
  /** Returns the current effective credential directory without I/O. */
  readonly authDirectory: () => string;
  /** Returns the immutable id of the active auth profile without I/O. */
  readonly authProfileId?: () => string;
  /** Session previews have already applied process policy to their profile input. */
  readonly roleEnvironment?: { readonly [key: string]: string | undefined };
  /** Resolves a stored credential, running the helper a leading `!` names.
   *  Required because an auth snapshot this surface builds itself must be able
   *  to reach a credential helper; a caller that already holds `auth` never
   *  reaches it. */
  readonly resolveKey: KeyResolver;
  /** Live enabled capability composition used for provider listing. */
  readonly moduleSelection: FirstPartyModuleSnapshot;
  /** Immutable config captured by the owning runtime or one-shot boundary. */
  readonly config: FlywheelConfig;
  /** Authored session and fixed launch fields, kept distinct from profile policy. */
  readonly sessionRoleAssignments?: RoleAssignmentSnapshot;
  /** For a workflow agent's session, the persona roles that each agent record of its run reads. */
  readonly agentPersonas?: AgentPersonaRoles;
  auth?: AuthContext;
  listingClient?: ModelListingClient;
  /** Resolved metadata from the same immutable offering snapshot as the listing. */
  modelInfos?: Pick<ReadonlyMap<string, ModelInfo>, "get" | "keys">;
  /** Revision of the admitted profile eligibility that owns model metadata. */
  readonly eligibilityRevision?: number;
  modelsClient?: ModelsClient;
  availableModels?: ReadonlyMap<ModelFamily, ReadonlySet<string>>;
  /** Published immutable eligibility catalogs for the active profile. */
  providerModelCatalogs?: () => ReadonlyMap<AccessProviderId, ResolvedProviderModels> | undefined;
  /** Published model-level serving projection for picker provenance. */
  providerModelEligibility?: () => ReadonlyMap<string, PickerModelEligibility> | undefined;
  slots?: readonly ModelSelectionSlot[];
  /** Complete project registry used for pruning, independent of requested slots. */
  configValidity?: ConfigValidity;
  /** Override the canonical global config path. Test-only. */
  configPath?: string;
  /** False for session snapshots that must never mutate global config. */
  persistConfig?: boolean;
}

export interface ModelPickerConfigDeps extends ModelConfigDeps {
  readonly providerModelEligibility: () => ReadonlyMap<string, PickerModelEligibility>;
  /** Query-owned selected routes keyed by canonical model id. */
  readonly selectedModelRoutes?: Pick<ReadonlyMap<string, SelectedModelRoute>, "get" | "keys">;
}
