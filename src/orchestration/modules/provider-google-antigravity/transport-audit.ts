import type { ProviderTransportAddition, ProviderTransportContext, ProviderTransportHiddenRequest } from "../../session/provider-request-audit-types.js"
import type { SyntheticPrompt } from "./session-view.js"

/** The name under which the audit shows what the engine added. It names the transport, never the product. */
const ENGINE_IDENTITY = "antigravity-engine"

/** What the engine session that ran a model step of one request holds beyond the request. agy sends all of it again on
 *  every model request of the session. */
interface AuditedStep {
  /** The session's append, in UTF-8 bytes: the system prompt and the history that the session opened with, as text. */
  readonly appendBytes: number
  /** The fixed prompts that the bridge sent to the session and that the request's history never holds. */
  readonly synthetic: readonly SyntheticPrompt[]
  /** The kinds of tool result that the bridge delivered to the session, which agy holds in every later model
   *  request: a result with its start and end times before it, and a failed result after agy's error text. */
  readonly delivered: { readonly results: boolean; readonly errors: boolean }
}

/** How one Flywheel request reached its engine session, as the audit names it. */
export interface AuditedRelease {
  /** The session whose model step the request ran. Absent when the request sent no model request: it failed or
   *  overflowed before any release, or it settled on a call that the session revealed without a new step. */
  readonly step?: AuditedStep
  /** The steps of the session that the gate refused while the request was open. */
  readonly refusedSteps: number
  /** Whether the request reported its usage (`RequestStream.usageReported`). */
  readonly usageReported: boolean
  /** The request's tools that the serving process did not declare at launch, which the model cannot call. */
  readonly missingTools: readonly string[]
  /** The tools that the serving process declares beyond the request's: the tree's tools that other agents hold, which
   *  the model sees and Flywheel's dispatch refuses for this agent (plan P3). */
  readonly sharedTools: readonly string[]
}

/**
 * What the engine added to the requests of one bridge, for the audit (ARCH-CONTEXT-008). Each model request of agy
 * wraps the session's append in agy's fixed agent text, injects a `toolSummary` argument into every tool, prefixes each
 * tool description and closes and orders each tool schema, declares agy's own `manage_task` tool and its MCP client's
 * resource tools, declares the tree's tools beyond the request's, wraps each prompt in its request tags with the local
 * time and its settings notices, puts start and end times before each tool result and its own error text before each
 * failed result, sets its own output cap and
 * thinking budget, and sends the session's fixed prompts again (agy 1.5.14, measured by the conformance suite against
 * the Google API route). A request that agy sent by itself, such as the title request of each new session or a step
 * that the gate did not admit, reaches the audit on the record of the request during which the bridge saw it, because
 * a record cannot belong to a request that Flywheel never made.
 */
export interface TransportAudit {
  /** A request that agy sent by itself. `source` is the code path: `title:<session kind>` or `unadmitted-step`. */
  hidden(source: string): void
  /** The record of the request that `release` describes, with every hidden request since the previous record. */
  record(release: AuditedRelease): ProviderTransportContext
}

const STEP_ADDITIONS: readonly ProviderTransportAddition[] = [
  { part: "message", kind: "prompt-wrapper" },
  { part: "body", kind: "tool-argument:toolSummary" },
  { part: "body", kind: "tool-description-prefix" },
  { part: "body", kind: "tool-schema-rewrite" },
  { part: "body", kind: "tool:manage_task" },
  { part: "body", kind: "tool:list_resources" },
  { part: "body", kind: "tool:read_resource" },
  { part: "body", kind: "generation-config" },
]

/** The additions of one model step. `at` of a system part is the system block that it precedes; `at` of a fixed prompt
 *  is the number of the request's messages before it, which is the index of the message that follows it. */
function stepAdditions(step: AuditedStep, sharedTools: readonly string[]): ProviderTransportAddition[] {
  return [
    { part: "system", kind: "agent-body", at: 0 },
    { part: "system", kind: "append", at: 0, value: String(step.appendBytes) },
    ...step.synthetic.map((prompt): ProviderTransportAddition => ({ part: "message", kind: prompt.kind === "primer" ? "primer" : "prompt:continuation", at: prompt.after })),
    ...step.delivered.results ? [{ part: "message", kind: "tool-result-timestamps" } as const] : [],
    ...step.delivered.errors ? [{ part: "message", kind: "tool-error-prefix" } as const] : [],
    ...STEP_ADDITIONS,
    ...sharedTools.map((name): ProviderTransportAddition => ({ part: "body", kind: `shared-tool:${name}` })),
  ]
}

export function createTransportAudit(): TransportAudit {
  let hidden: ProviderTransportHiddenRequest[] = []
  return {
    hidden(source) {
      hidden.push({ source })
    },
    record(release) {
      const carried = hidden
      hidden = []
      const additions = [
        ...release.step === undefined ? [] : stepAdditions(release.step, release.sharedTools),
        ...release.refusedSteps === 0 ? [] : [{ part: "message" as const, kind: "refused-step", value: String(release.refusedSteps) }],
      ]
      const notRecorded = [
        ...release.usageReported ? [] : ["usage"],
        // The agent text is fixed for every login, and the record names it without a hash of its bytes.
        ...release.step === undefined ? [] : ["agent-body-hash"],
        // agy retries its title request by itself and states no count of the attempts.
        ...carried.some((request) => request.source.startsWith("title:")) ? ["title-attempts"] : [],
        ...release.missingTools.map((name) => `launch-tool:${name}`),
      ]
      return { identity: ENGINE_IDENTITY, additions, hiddenRequests: carried, notRecorded }
    },
  }
}
