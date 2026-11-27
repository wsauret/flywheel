import { isProtocolModuleDomain, protocolDomain, type ProtocolModuleDomainName } from "../modules.js"
import type { RuntimeKernelDomain, RuntimeUiDomain } from "../runtime/runtime-ui-protocol-types.js"

/** How each runtime domain delivers its ordered patches. The table covers the
 *  kernel domains and defers a module domain to its protocol home, so it sits
 *  above both the patch types and the module registry. */

export type RuntimeDeliveryPolicy = "durable-resnapshot" | "latest-collapsible" | "query-only"

/** What one patch of a domain states.
 *  - `whole-value`: the cursor's whole value, so applying the payload twice
 *    equals applying it once. A sparse total merge qualifies, because it is
 *    idempotent. The public bus does not publish an equal repeat.
 *  - `change`: an edit, a fold step, or a signal with no value, so every
 *    patch publishes. */
export type RuntimePatchContent = "whole-value" | "change"

/** A domain's delivery policy and patch content. The newest latest-collapsible
 *  patch supersedes any it overtook, which is true only when it states a whole
 *  value, so the type admits no other pairing. */
export type RuntimeDomainDelivery =
  | { readonly delivery: "latest-collapsible"; readonly content: "whole-value" }
  | { readonly delivery: "durable-resnapshot" | "query-only"; readonly content: RuntimePatchContent }

const collapsible = { delivery: "latest-collapsible", content: "whole-value" } as const
const durableWholeValue = { delivery: "durable-resnapshot", content: "whole-value" } as const
const durableChange = { delivery: "durable-resnapshot", content: "change" } as const

/** One delivery row per kernel domain. The `satisfies` clause is the
 *  compile-time gate: a new kernel domain fails this record (and therefore the
 *  build) until it declares how its patches are delivered and what each one
 *  states. A module domain declares both in its protocol home, where the same
 *  completeness rule holds. */
const RUNTIME_DELIVERY_POLICY = {
  // Each row carries its sparse totals, and added and updated differ by kind.
  session: durableWholeValue,
  session_detail: durableWholeValue,
  // A signal with no value: a client reads the summary again on each one.
  changes: durableChange,
  // Each patch states one row of the index or its removal, not the whole
  // index, so a client that missed one reads the index again.
  background: durableChange,
  output: durableChange,
  status: collapsible,
  budget: durableWholeValue,
  question: durableWholeValue,
  // The web client reads a roles patch as a signal that the session's
  // metadata changed and reads its model assignments again, so an equal
  // repeat still carries news.
  roles: durableChange,
  runtime: { delivery: "query-only", content: "change" },
  // One patch carries providers and the complete effective-profile view.
  auth: collapsible,
  // A roster patch carries the whole roster, so the newest supersedes any it
  // overtook and a client that missed one needs no resnapshot.
  commands: collapsible,
  // One patch carries the whole update view (state plus effective policy), so
  // the newest supersedes any it overtook.
  updates: collapsible,
  // One patch carries the complete selection and the derived Workflows mode, so
  // the newest supersedes any it overtook.
  modules: collapsible,
  config: collapsible,
  gitAiAttribution: collapsible,
  // One patch carries the whole repository view.
  git: collapsible,
  // One patch carries every count.
  commandUsage: collapsible,
  chat_default: collapsible,
  // One patch carries the whole executor state.
  executor: collapsible,
  // One patch carries the whole service state.
  service: collapsible,
  // A wake with no value and no resident client state: a client that waits
  // on a chat asks `chatSettlement` again on each one.
  settlement: { delivery: "query-only", content: "change" },
  // One patch carries every session that waits on a question.
  waitingSessions: collapsible,
  // One patch carries every stopped unread chat and every chat with unread
  // messages, and only the turn times its change moved: a sparse merge, so a
  // patch that a newer one overtook still carries news, and a client that
  // missed one reads the set again.
  unreadChats: durableWholeValue,
} as const satisfies { readonly [D in RuntimeKernelDomain]: RuntimeDomainDelivery }

export function runtimeDeliveryPolicy(domain: RuntimeUiDomain): RuntimeDeliveryPolicy {
  return isProtocolModuleDomain(domain) ? protocolDomain(domain).delivery : RUNTIME_DELIVERY_POLICY[domain].delivery
}

export function runtimePatchContent(domain: RuntimeUiDomain): RuntimePatchContent {
  return isProtocolModuleDomain(domain) ? protocolDomain(domain).content : RUNTIME_DELIVERY_POLICY[domain].content
}

type RuntimeQueryOnlyUiDomain = { [D in RuntimeKernelDomain]: (typeof RUNTIME_DELIVERY_POLICY)[D]["delivery"] extends "query-only" ? D : never }[RuntimeKernelDomain]

/** The client-side obligation the delivery policies impose (2026-07-08 audit,
 *  finding M7): every domain that publishes ordered patches must have a live
 *  client intake, so the TUI's construction site declares one binding per
 *  domain and checks the record against this type. A new domain fails
 *  compilation until it is bound to a receiver - or, for `query-only` domains
 *  with no live stream, explicitly opts out. The stale-pane failure mode is a
 *  missing binding; the omission must be a build error, not a runtime gap. */
export type RuntimeDomainIntakeBindings =
  & { readonly [D in Exclude<RuntimeKernelDomain, RuntimeQueryOnlyUiDomain>]: object }
  & { readonly [D in RuntimeQueryOnlyUiDomain]: object | "query-only" }
  & { readonly [D in ProtocolModuleDomainName]: object }
