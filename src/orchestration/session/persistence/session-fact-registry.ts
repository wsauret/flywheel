import { collectFactSchemas, createFactParser } from "../../../infra/substrate/facts/event-registry.js"
import { installedModules } from "../../module-contract/module-catalog.js"
import { FileMutationFactSchemas } from "../file-mutations/file-mutation-facts.js"
import { SessionForkFactSchemas } from "../metadata/session-fork-facts.js"
import { SessionMetadataFactSchemas } from "../metadata/session-metadata-facts.js"
import { SessionRuntimeFactSchemas, ToolContentReferenceFactSchemas } from "../runtime-facts/session-runtime-event-types.js"
import { ConversationTreeFactSchemas } from "../conversation/conversation-facts.js"
import { AgentInputFactSchemas } from "../agent-input/agent-input-facts.js"
import { ChatTurnStopFactSchemas } from "./chat-turn-stop-facts.js"
import { ChatReadReceiptFactSchemas } from "./chat-read-receipt-facts.js"
import { ProviderRequestAuditFactSchemas } from "../runtime-facts/provider-request-audit-facts.js"
import { ConversationCheckpointFactSchemas } from "./conversation-checkpoint-facts.js"
import { ConversationRolePickFactSchemas } from "./conversation-role-pick-facts.js"
import { ConversationPromptBaselineFactSchemas } from "./conversation-prompt-baseline-facts.js"

const FACT_MODULES = [
  ConversationCheckpointFactSchemas,
  ConversationRolePickFactSchemas,
  ConversationPromptBaselineFactSchemas,
  AgentInputFactSchemas,
  ChatTurnStopFactSchemas,
  ChatReadReceiptFactSchemas,
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
let sessionFactParser: ReturnType<typeof createFactParser> | undefined

/** A strict parser over the kernel facts and the facts of every installed
 * module, whether or not a project enables it, so a disabled owner's facts stay
 * readable. The first read composes it, because the catalog and the module
 * schemas load lazily; the installed catalog is one frozen value for the
 * process, so one composition serves every later read. A failed composition
 * publishes no partial parser, and the next read tries again. */
export const parseSessionFact: ReturnType<typeof createFactParser> = (input) => {
  sessionFactParser ??= createFactParser([...KERNEL_FACT_SCHEMAS, ...installedModules().flatMap((module) => module.facts?.sessionSchemas?.() ?? [])])
  return sessionFactParser(input)
}
