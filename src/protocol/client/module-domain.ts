import { Schema } from "effect"
import type { RuntimeClient } from "../app-service-types.js"
import { isProtocolModuleDomain, PROTOCOL_MODULE_DOMAINS, protocolDomain, protocolModuleQuery, type ProtocolModuleDomain, type ProtocolModuleDomainName, type ProtocolModuleEntry, type ProtocolModuleView } from "../modules.js"
import { protocolDomainTable, type AnyProtocolDomain, type DomainReader, type ProtocolDomain, type ProtocolDomainView } from "../protocol-module.js"
import { sessionDomainCursor, workspaceDomainCursor, type RuntimeCursorIdentity, type RuntimeDeliveryPolicy, type RuntimePosition } from "../runtime-ui-protocol-types.js"

/** A registry entry as a client consumes it: one object whose read, patch
 *  test, and view folds all carry the entry's own types, so an intake built
 *  from it is typed end to end and names no module. */
export interface ModuleDomainSnapshot<View> {
  readonly snapshotPosition: RuntimePosition
  readonly view: View | null
}

export interface ModuleDomainBinding<Domain extends string, Scope extends "session" | "workspace" | "workflow", Patch, View> {
  readonly domain: Domain
  readonly scope: Scope
  readonly delivery: RuntimeDeliveryPolicy
  /** The domain's cursor; the session id is required for session scope. */
  cursor(sessionId?: string): RuntimeCursorIdentity
  read(client: Pick<RuntimeClient, "query">, sessionId?: string): Promise<ModuleDomainSnapshot<View>>
  isPayload(payload: unknown): payload is Patch
  /** Folds one patch into the view the client holds. */
  payloadView(payload: Patch, current: View | undefined): View | null
}

export type ModuleDomainBindingOf<D extends AnyProtocolDomain> = D extends ProtocolDomain<infer Domain, infer Scope, infer _Spec, infer _Snapshot, infer Patch, infer View>
  ? ModuleDomainBinding<Domain, Scope, Patch, View>
  : never

/** Built over the loose base shape, whose view fold accepts the base snapshot
 *  and patch types; the registry union's entries all satisfy it, and the union
 *  itself keeps the scope discriminant the cursor and query need. The table
 *  below restores each key's precise types. */
function bindModuleDomain(domain: ProtocolModuleDomain): ModuleDomainBindingOf<AnyProtocolDomain> {
  const entry: AnyProtocolDomain = domain
  return {
    domain: domain.domain,
    scope: domain.scope,
    delivery: domain.delivery,
    cursor(sessionId) {
      if (domain.scope === "workspace") return workspaceDomainCursor(domain.domain)
      if (sessionId === undefined) throw new Error(`The ${domain.domain} domain is session-scoped and needs a session id`)
      if (domain.scope === "workflow") return { scope: "workflow", domain: domain.domain, workflowId: sessionId }
      return sessionDomainCursor(domain.domain, sessionId)
    },
    async read(client, sessionId) {
      const snapshot = await client.query(protocolModuleQuery(domain, sessionId))
      return { snapshotPosition: snapshot.snapshotPosition, view: entry.view.snapshot(snapshot) }
    },
    isPayload: Schema.is(entry.patch),
    payloadView: (payload, current) => entry.view.patch(payload, current),
  }
}

/** What a client holds for one registry entry: that entry's view, or nothing yet. */
export type ModuleDomainLookup = (domain: ProtocolModuleDomain) => ProtocolModuleView<ProtocolModuleDomainName> | null | undefined

/** A `DomainReader` over whatever a client holds per registry domain. The
 *  client supplies one lookup by registry entry; this restores the entry's
 *  declared view type, so every row selector and module surface reads typed
 *  and the cast lives in one place. A domain the registry does not hold reads
 *  as absent. `answering` says whether the runtime answers this client now;
 *  while it does not, a domain's view reads as its `unanswered` form, so no
 *  reader shows a held claim about the present as current. */
export function moduleDomainReader(lookup: ModuleDomainLookup, answering: () => boolean = () => true): DomainReader {
  return <D extends AnyProtocolDomain>(domain: D): ProtocolDomainView<D> | undefined => {
    if (!isProtocolModuleDomain(domain.domain)) return undefined
    const registered = protocolDomain(domain.domain)
    const entry: AnyProtocolDomain = registered
    const held = lookup(registered) ?? undefined
    const view = held !== undefined && entry.unanswered !== undefined && !answering() ? entry.unanswered(held) : held
    // SAFETY: the lookup answers the entry registered under `domain.domain`, whose declared view type is `ProtocolDomainView` of that entry; the lookup's contract erases it.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry lookup by domain name
    return view as ProtocolDomainView<D> | undefined
  }
}

/** One binding per registry domain, keyed by domain name and typed by that
 *  domain's own entry. */
export const MODULE_DOMAIN_BINDINGS: { readonly [Name in ProtocolModuleDomainName]: ModuleDomainBindingOf<ProtocolModuleEntry<Name>> } =
  // SAFETY: each key's binding is built from that key's own entry, so its read answers that entry's snapshot and its folds are that entry's; the loose base shape the builder types against erases that.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed table
  protocolDomainTable(PROTOCOL_MODULE_DOMAINS, bindModuleDomain) as { readonly [Name in ProtocolModuleDomainName]: ModuleDomainBindingOf<ProtocolModuleEntry<Name>> }
