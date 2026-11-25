// The whole shipped catalog: both registries. Tests and repository scripts
// read it; a process loads the registries through src/cli and reads the
// catalog they publish (module-catalog.ts).
import { CREDENTIAL_PROVIDER_MODULES } from "../src/orchestration/credential-provider-modules.js"
import type { DEVELOPMENT_MODULES } from "../src/orchestration/development-modules.js"
import type { FirstPartyModule, ModuleId } from "../src/orchestration/module-catalog.js"
import { SHIPPED_OTHER_MODULES } from "../src/orchestration/modules.js"

/** The catalog every release composes from. */
export const SHIPPED_MODULES = [...CREDENTIAL_PROVIDER_MODULES, ...SHIPPED_OTHER_MODULES] as const satisfies readonly FirstPartyModule[]

type CatalogModuleId = (typeof SHIPPED_MODULES)[number]["id"] | (typeof DEVELOPMENT_MODULES)[number]["id"]

/** Both directions against the wire vocabulary in `protocol/runtime/module-ids.ts`,
 *  which `ModuleId` names, so a module registered without its id there, and an
 *  id there with no module behind it, are each a compile error at their own
 *  source rather than a decode failure at the first wire frame that carries
 *  them. The proof lives on this side of the boundary because the protocol
 *  package never names an orchestration path, and the type-only import of the
 *  development catalog is erased before it can drag that catalog into a
 *  release bundle. */
type RegistryStatesVocabulary = CatalogModuleId extends ModuleId ? true : never
type VocabularyStatesRegistry = ModuleId extends CatalogModuleId ? true : never
const _registryStatesVocabulary: RegistryStatesVocabulary = true; const _vocabularyStatesRegistry: VocabularyStatesRegistry = true
