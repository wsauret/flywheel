import { skillStoreRoots, type SkillStoreRoot } from "../../../workflows/skills.js"
import type { CapabilityAccess } from "../../agent-runtime/tools/types.js"
import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import type { DefinitionReconciliationInput } from "../../module-seams.js"
import { Log } from "../../../infra/log.js"
import { readConsentClaims, reconcileGlobalSkillOperations, reconcileGlobalSkillStores, type ConsentClaims } from "./global-skill-mutation.js"

const log = Log.create({ service: "definition-reconciliation" })

/** Reloading installed definitions is mandatory. Only this optional mutation
 *  phase asks for managed-write authority before it changes a global store. */
export async function reconcileDefinitionRoots(options: {
  readonly roots: readonly SkillStoreRoot[]
  readonly consentClaims?: () => ConsentClaims | undefined
  readonly capabilities?: Pick<CapabilityAccess, "admit">
}): Promise<void> {
  if (!await admitReconciliation(options.capabilities)) return
  for (const root of options.roots.filter((candidate) => candidate.owned && candidate.reach === "global")) {
    reconcileGlobalSkillOperations(root.dir, options.consentClaims?.())
  }
}

/** One admission owns both startup passes. A later reload prepares a new
 * operation against current policy while installed definitions stay readable. */
export async function prepareLearningDefinitionReconciliation(input: DefinitionReconciliationInput): Promise<((reader?: AsyncEventStateReadSurface) => Promise<void>) | undefined> {
  if (!await admitReconciliation(input.capabilities)) return undefined
  return async (reader) => {
    const globalRoots = skillStoreRoots(input.directories).filter((root) => root.owned && root.reach === "global").map((root) => root.dir)
    reconcileGlobalSkillStores(input.directories, reader ? await readConsentClaims(reader, input.directories.projectRoot, globalRoots) : undefined)
  }
}

async function admitReconciliation(capabilities: Pick<CapabilityAccess, "admit"> | undefined): Promise<boolean> {
  if (!capabilities) return true
  const admission = await capabilities.admit({ operation: "global skill reconciliation", required: ["skills", "learning"] })
  if (admission.ok) return true
  log.debug(`global skill reconciliation skipped: ${admission.reason}`)
  return false
}
