import { createSignal, untrack, type Accessor } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { MODULE_DOMAIN_BINDINGS, moduleDomainReader, type ModuleDomainBinding, type ModuleDomainSnapshot } from "../../protocol/client/module-domain.js"
import { PROTOCOL_MODULE_DOMAINS, PROTOCOL_MODULE_SESSION_DOMAINS, type ProtocolModuleDomainName, type ProtocolModuleEntry, type ProtocolModuleSessionDomain, type ProtocolModuleView, type ProtocolModuleWorkspaceDomain } from "../../protocol/modules.js"
import { protocolDomainTable, type DomainReader } from "../../protocol/protocol-module.js"
import { sessionDomainCursor, workspaceDomainCursor, type RuntimeUiPatch, type RuntimeUiPatchPayload } from "../../protocol/runtime-ui-protocol-types.js"
import { runtimeSnapshotScopeKey } from "../../protocol/client/family-intake.js"
import { createOrderedPatchReceiver } from "./create-ordered-patch-receiver.js"
import { createPerSessionCache, type PerSessionCache } from "./create-per-session-cache.js"
import { createWorkflowDomainIntake, type WorkflowDomainIntake } from "./create-workflow-domain-intake.js"

/** The terminal's intake for every module domain in the protocol registry: a
 *  per-session cache for a session-scoped domain and one signal of the view
 *  for a workspace-scoped domain. A module's terminal home reads its own
 *  through a `DomainReader`; nothing here names a module. */
interface WorkspaceDomainIntake<View> {
  readonly scope: "workspace"
  /** Undefined until the first snapshot lands. */
  readonly view: Accessor<View | undefined>
}

type SessionDomainIntake<View> = PerSessionCache<View> & { readonly scope: "session" }

type ModuleDomainIntake<Name extends ProtocolModuleDomainName> = ProtocolModuleEntry<Name>["scope"] extends "session"
  ? SessionDomainIntake<ProtocolModuleView<Name>>
  : ProtocolModuleEntry<Name>["scope"] extends "workflow" ? WorkflowDomainIntake<ProtocolModuleView<Name>> : WorkspaceDomainIntake<ProtocolModuleView<Name>>

export type ModuleDomainIntakes = { readonly [Name in ProtocolModuleDomainName]: ModuleDomainIntake<Name> }

interface ModuleDomainIntakeDeps {
  readonly appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  /** The bulkheaded client per-session hydration goes through, so a catalog
   *  sweep cannot occupy every runtime RPC slot. */
  readonly hydration: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
}

export function createModuleDomainIntakes(deps: ModuleDomainIntakeDeps): ModuleDomainIntakes {
  // SAFETY: each key's intake is built from that key's own binding; the table builder types every value as the union.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed table
  return protocolDomainTable(PROTOCOL_MODULE_DOMAINS, (domain) => {
    const binding = MODULE_DOMAIN_BINDINGS[domain.domain]
    return binding.scope === "session" ? createSessionDomainIntake(binding, deps.hydration)
      : binding.scope === "workflow" ? createWorkflowDomainIntake<unknown>(binding, deps.hydration)
      : createWorkspaceDomainIntake(binding, deps.appService)
  }) as ModuleDomainIntakes
}

/** A reader over these intakes: workspace views as they are, session views
 *  for `sessionId`, which is the foreground for rows and the captured session
 *  for a strip or surface. `answering` is whether the runtime answers this
 *  terminal now, which decides whether a held view may read as current.
 *  Reads track their signals, so a memo over the reader follows every view it
 *  read. */
export function createDomainReader(intakes: ModuleDomainIntakes, sessionId: Accessor<string | undefined>, answering: Accessor<boolean>): DomainReader {
  return moduleDomainReader((domain) => {
    const intake: ModuleDomainIntakes[ProtocolModuleDomainName] = intakes[domain.domain]
    if (intake.scope === "workspace") return intake.view()
    const id = sessionId()
    return id === undefined ? undefined : intake.view(id)
  }, answering)
}

/** Hydrates every session-scoped module domain for one session, so the
 *  session's strips and rows hold their views once it is in front. */
export function ensureModuleSessionDomains(intakes: ModuleDomainIntakes, sessionId: string): void {
  for (const name of PROTOCOL_MODULE_SESSION_DOMAINS) intakes[name].ensure(sessionId)
}

/** Both builders take the loose base binding of their scope: every registry
 *  entry of that scope satisfies it, and the table above restores each key's
 *  precise view type. The binding's own predicate still decides membership. */
function createSessionDomainIntake(
  binding: ModuleDomainBinding<ProtocolModuleSessionDomain, "session", RuntimeUiPatchPayload, unknown>,
  appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">,
): SessionDomainIntake<unknown> {
  return {
    scope: "session",
    ...createPerSessionCache({
      domain: binding.domain,
      cursor: (sessionId) => sessionDomainCursor(binding.domain, sessionId),
      client: appService,
      // A module's snapshot query reads one session, so each read is a
      // one-entry batch.
      readsOneSession: true,
      query: async (sessionIds) => {
        const [sessionId, ...rest] = sessionIds
        if (sessionId === undefined || rest.length > 0) throw new Error(`module domain ${binding.domain} reads one session per snapshot`)
        const snapshot = await binding.read(appService, sessionId)
        return { snapshotPosition: snapshot.snapshotPosition, views: [{ sessionId, view: snapshot.view }] }
      },
      isPayload: (payload): payload is RuntimeUiPatchPayload => binding.isPayload(payload),
      payloadView: (payload, current) => binding.payloadView(payload, current),
    }),
  }
}

function createWorkspaceDomainIntake(
  binding: ModuleDomainBinding<ProtocolModuleWorkspaceDomain, "workspace", RuntimeUiPatchPayload, unknown>,
  appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">,
): WorkspaceDomainIntake<unknown> {
  const [view, setView] = createSignal<unknown>()
  const cursor = workspaceDomainCursor(binding.domain)
  const scope = { kind: "cursor", cursor } as const
  createOrderedPatchReceiver<typeof scope, ModuleDomainSnapshot<unknown>, RuntimeUiPatch & { payload: RuntimeUiPatchPayload }>({
    client: appService,
    connectedScope: () => scope,
    accept(patch) {
      if (patch.cursor.scope !== "workspace" || patch.cursor.domain !== binding.domain) return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope }
      return binding.isPayload(patch.payload) ? { cursor, scope, patch: { ...patch, payload: patch.payload } } : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: () => binding.read(appService),
    applySnapshot(snapshot) {
      setView(() => snapshot.view ?? undefined)
      return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] }
    },
    applyPayload(patch) {
      const folded = binding.payloadView(patch.payload, untrack(view))
      setView(() => folded ?? undefined)
    },
  })
  return { scope: "workspace", view }
}
