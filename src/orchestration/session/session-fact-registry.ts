import { collectFactSchemas, createFactParser } from "../../infra/event-registry.js"
import type { FirstPartyModule } from "../modules.js"
import { installedModules } from "../module-catalog.js"
import { FileMutationFactSchemas } from "./file-mutation-facts.js"
import { SessionForkFactSchemas } from "./session-fork-facts.js"
import { SessionMetadataFactSchemas } from "./session-metadata-facts.js"
import { SessionRuntimeFactSchemas, ToolContentReferenceFactSchemas } from "./session-runtime-event-types.js"
import { ConversationTreeFactSchemas } from "./conversation/conversation-facts.js"
import { AgentInputFactSchemas } from "./agent-input-facts.js"
import { ProviderRequestAuditFactSchemas } from "./provider-request-audit-facts.js"
import { ConversationCheckpointFactSchemas } from "./conversation-checkpoint-facts.js"

const FACT_MODULES = [
  ConversationCheckpointFactSchemas,
  AgentInputFactSchemas,
  FileMutationFactSchemas,
  SessionForkFactSchemas,
  SessionMetadataFactSchemas,
  ProviderRequestAuditFactSchemas,
  SessionRuntimeFactSchemas,
  // The reference-capable stored versions of the tool facts (tool output
  // dedup): registered at the write gate so a producer can record them, while
  // projections keep parsing only the hydrated inline shape.
  ToolContentReferenceFactSchemas,
  ConversationTreeFactSchemas,
] as const

const KERNEL_FACT_SCHEMAS = collectFactSchemas(FACT_MODULES)
/** Construct a strict, lazy parser over one installed catalog authority.
 * Disabled owners retain their decoders. Catalog replacement rebuilds the
 * parser, and a failed schema composition never publishes a partial parser. */
export function createSessionFactParser(readCatalog: () => readonly FirstPartyModule[]): ReturnType<typeof createFactParser> {
  let catalog: readonly FirstPartyModule[] | undefined
  let parser: ReturnType<typeof createFactParser> | undefined
  return (input) => {
    const installed = readCatalog()
    if (catalog !== installed || parser === undefined) {
      parser = createFactParser([...KERNEL_FACT_SCHEMAS, ...installed.flatMap((module) => module.facts?.sessionSchemas?.() ?? [])])
      catalog = installed
    }
    return parser(input)
  }
}

export const parseSessionFact = createSessionFactParser(installedModules)
