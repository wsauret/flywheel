import { createModuleCatalogSlot } from "../infra/module-descriptor.js"
import type { ModuleRuntimeInvocationTool, SupersededFactInvalidationResult } from "./module-seams.js"
import type { FirstPartyModule } from "./modules.js"
import type { DefinitionBundle } from "../workflows/loader.js"
import type { AnyFactSchema } from "../infra/event-registry.js"
import type { AsyncEventReadSurface, AsyncEventStateReadSurface } from "../infra/event-store-types.js"
import type { WorkflowRunReader, WorkflowRunWriter } from "./workflow-host/run-record.js"
import type { SessionManager } from "./session/manager.js"

/** What every installed module declares for its durable history. The catalog
 *  reads it whether or not a project enables the module, because history that
 *  a disabled module wrote still replays. */
export interface InstalledModuleHistory {
  /** The type prefixes of the durable fact families this module owns. The
   *  retention registry names the owner per family; the prefixes are the
   *  module's namespace claim, and `bun run lint:fact-retention` fails a family
   *  the registry gives this module that carries none of them (ARCH-STRUCTURE-023). */
  readonly facts?: {
    readonly prefixes: readonly string[]
    readonly sessionSchemas?: () => readonly AnyFactSchema[]
    readonly invalidateSuperseded?: (dbPath: string) => SupersededFactInvalidationResult
  }
  /** Fact types that delete a session's conversation without a
   *  `session.deleted` fact, so a derived transcript index drops that
   *  session's rows. */
  readonly conversationDeletionFacts?: readonly string[]
  readonly runtimeInvocationTool?: ModuleRuntimeInvocationTool
}

// The catalog has two halves, and each registry publishes its own tuple into
// this light authority when it loads. The credential provider registry lists
// every module that claims a credential provider id; the module registry lists
// every other module and composes both. A login reads only the first half, so
// it never loads a tool. Catalog consumers never import a registry back, and an
// entry can install its lazy override of either half before any catalog read.
const credentialProviderSlot = createModuleCatalogSlot<FirstPartyModule>()
const otherModuleSlot = createModuleCatalogSlot<FirstPartyModule>()

/** Replaces one or both halves of the catalog every composition in this
 *  process reads. Only a source or test entry calls it: the source entry adds
 *  the development catalog to the other modules, and a test or bench entry
 *  replaces a credential provider. A release runs the shipped halves alone. */
export function installModuleCatalog(loaders: {
  readonly credentialProviders?: () => readonly FirstPartyModule[]
  readonly otherModules?: () => readonly FirstPartyModule[]
}): void {
  if (loaders.credentialProviders) credentialProviderSlot.install(loaders.credentialProviders)
  if (loaders.otherModules) otherModuleSlot.install(loaders.otherModules)
}

/** The credential provider registry publishes its shipped tuple after its
 *  descriptors load. Publication leaves an override and the read lock unchanged. */
export const publishShippedCredentialProviders: (modules: readonly FirstPartyModule[]) => void = credentialProviderSlot.publish

/** The module registry publishes its shipped tuple of every other module. */
export const publishShippedOtherModules: (modules: readonly FirstPartyModule[]) => void = otherModuleSlot.publish

/** Every installed module that claims a credential provider id, whether or not
 *  a project enables it. Reading it loads no other module. Missing bootstrap is
 *  an ownership error; a reader never substitutes an empty vocabulary. */
export function installedCredentialProviderModules(): readonly FirstPartyModule[] {
  const installed = credentialProviderSlot.installed()
  if (!installed) throw new Error("The credential provider registry has not initialized this realm")
  const silent = installed.find((module) => !claimsCredentialProvider(module))
  if (silent) throw new Error(`Credential provider module ${silent.id} claims no credential provider id`)
  return installed
}

let catalog: readonly FirstPartyModule[] | undefined

/** Read the whole catalog initialized by this realm's composition: one frozen
 *  value for the process, because every composition cache keys on it. Missing
 *  bootstrap is an ownership error; a session writer never substitutes an
 *  empty registry. */
export function installedModules(): readonly FirstPartyModule[] {
  if (catalog) return catalog
  // The other half first: its lazy loader loads the module registry, which
  // loads the credential provider registry and so publishes that half.
  const others = otherModuleSlot.installed()
  if (!others) throw new Error("The module registry has not initialized this realm")
  const claimant = others.find(claimsCredentialProvider)
  if (claimant) throw new Error(`Module ${claimant.id} claims a credential provider id outside the credential provider registry`)
  catalog = Object.freeze([...installedCredentialProviderModules(), ...others])
  return catalog
}

/** Reads retained runs from the installed catalog, independent of admission. */
export function workflowRunReader(reader: AsyncEventStateReadSurface): WorkflowRunReader {
  return workflowRunOwner().create(reader)
}

/** Where the retained workflows of `reader` sit in the session tree, independent of admission. */
export function workflowPlacements(reader: AsyncEventReadSurface): import("./module-seams.js").WorkflowPlacements {
  return workflowRunOwner().placements(reader)
}

/** Binds aggregate settings to the state authority that fences structural writes. */
export function workflowRunWriter(reader: AsyncEventStateReadSurface, commit: SessionManager["commitWorkflow"]): WorkflowRunWriter {
  return workflowRunOwner().writer(reader, commit)
}

let runOwner: import("./module-seams.js").ModuleWorkflowRuns | undefined

/** The installed workflow owner contributes run operations even while new
 *  admission is disabled. The catalog is frozen for the process, so the owner
 *  is found once: the summary replay asks for it once per fact. */
export function workflowRunOwner(): import("./module-seams.js").ModuleWorkflowRuns {
  if (runOwner) return runOwner
  const owners = installedModules().flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "workflowRuns" ? [contribution.value] : []))
  if (owners.length !== 1 || !owners[0]) throw new Error("The installed catalog must contain one workflow run owner")
  runOwner = owners[0]
  return runOwner
}

/** A credential provider id names an access provider or a web auth provider. */
function claimsCredentialProvider(module: FirstPartyModule): boolean {
  return module.contributions.some((contribution) => contribution.domain === "providers" || contribution.domain === "webAuthProviders")
}


/** The tool that runtime invocations record. Exactly one installed module
 *  owns it, whether or not a project enables that module, because history
 *  that a disabled module wrote still replays. */
export function installedRuntimeInvocationTool(modules: readonly FirstPartyModule[] = installedModules()): ModuleRuntimeInvocationTool {
  const [tool, ...others] = modules.flatMap((module) => module.runtimeInvocationTool ? [module.runtimeInvocationTool] : [])
  if (!tool || others.length > 0) throw new Error(`Expected one installed runtime invocation tool, found ${others.length + (tool ? 1 : 0)}`)
  return tool
}

/** The fact types beyond `session.deleted` that delete a session's
 *  conversation, from every installed module: a disabled module's deletions
 *  are still history that the transcript index must honor. */
export function installedConversationDeletionFacts(modules: readonly FirstPartyModule[] = installedModules()): readonly string[] {
  return modules.flatMap((module) => module.conversationDeletionFacts ?? [])
}

/** Every definition bundle the installed catalog contributes, whether or not
 *  a project enables the owner: the registry loads them all, and availability
 *  hides a bundle's definitions while its owner is off. */
export function installedDefinitionBundles(modules: readonly FirstPartyModule[] = installedModules()): readonly DefinitionBundle[] {
  return modules.flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "definitions" && contribution.value.kind === "bundle" ? [{ id: contribution.id, root: contribution.value.root }] : []))
}

/** The agent types that `config` turns off, as the installed module that owns dispatch reads them: a decoded
 *  configuration, or the module sections of a request capture. Only the inputs of the availability owner read
 *  them (ARCH-STRUCTURE-044). */
export function disabledAgentTypes(config: { readonly [section: string]: unknown }, modules: readonly FirstPartyModule[] = installedModules()): readonly string[] {
  return modules.flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "definitions" && "disabledTypes" in contribution.value ? contribution.value.disabledTypes(config) : []))
}

/** Two modules cannot share a fact namespace: a prefix that is itself a
 *  prefix of another module's claim would give one family two owners. */
export function validateModuleFactPrefixes(modules: readonly FirstPartyModule[]): void {
  const claims = modules.flatMap((module) => (module.facts?.prefixes ?? []).map((prefix) => ({ prefix, module: module.id })))
  for (const claim of claims) {
    const overlapping = claims.find((other) => other.module !== claim.module && other.prefix.startsWith(claim.prefix))
    if (overlapping) throw new Error(`Fact prefix ${claim.prefix} is claimed by both ${claim.module} and ${overlapping.module} (${overlapping.prefix})`)
  }
}
