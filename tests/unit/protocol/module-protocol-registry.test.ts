import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { RuntimeQuery, RuntimeQueryResult } from "../../../src/protocol/app-service-types.js"
import { runtimeQuery } from "../../helpers/runtime-dispatch.js"
import { MODULE_DOMAIN_BINDINGS } from "../../../src/protocol/client/module-domain.js"
import { moduleHostCommand, PROTOCOL_BACKGROUND_DOMAINS, protocolBackgroundSchema } from "../../../src/protocol/modules.js"
import type { RuntimeExperimentViewSnapshotResult } from "../../../src/protocol/modules/experiments.js"
import {
  defineProtocolDomain,
  defineProtocolModule,
  defineProtocolMutation,
  defineProtocolQuery,
  protocolBackgroundDomains,
  protocolDomainNames,
  protocolDomainTable,
  protocolDomains,
  protocolMutations,
  protocolMutationSchema,
  protocolMutationTable,
  protocolQueryTable,
  protocolReads,
  protocolReadSchema,
  type ProtocolDomainOf,
  type ProtocolDomainPatch,
  type ProtocolDomainQuery,
  type ProtocolDomainSnapshot,
  type ProtocolDomainView,
  type ProtocolModule,
  type ProtocolMutationOf,
  type ProtocolMutationRequest,
  type ProtocolMutationResult,
  type ProtocolQueryOf,
  type ProtocolQueryRequest,
  type ProtocolQueryResult,
} from "../../../src/protocol/protocol-module.js"
import { composeModuleProtocolRuntimes, type ModuleBackgroundReaders, type ModuleProtocolRoutes, type ModuleProtocolRuntime } from "../../../src/orchestration/app-service/module-protocol-host.js"
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js"
import { repoDefinitions } from "../../helpers/project-definitions.js"
import { fakeManager, fakeSessionStore } from "../orchestration/app-service/app-service-doubles.js"
import { NO_MODULE_SERVICES } from "../../../src/infra/module-service.js"
import type { FirstPartyModule } from "../../../src/orchestration/modules.js"
import { runtimeCallPolicies } from "../../../src/protocol/runtime-client-deadlines.js"
import { RuntimeCursorIdentitySchema } from "../../../src/protocol/runtime-cursor-schemas.js"
import { RuntimeProtocolRpc, RuntimeUiPatchSchema, runtimeQueryResultSchema } from "../../../src/protocol/runtime-protocol-schemas.js"
import { KERNEL_SESSION_DOMAINS, KERNEL_WORKSPACE_DOMAINS, runtimeDeliveryPolicy, type RuntimeDomainIntakeBindings, type RuntimeUiPatch } from "../../../src/protocol/runtime-ui-protocol-types.js"
import { recursiveUnionMembers, stringDiscriminatorLiterals } from "../../../src/protocol/schema-union.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

test("host command integrations resolve declared keys and reject ambiguous catalogs", () => {
  const module: ProtocolModule = { id: "development", domains: [], hostCommands: [{ key: "inspectWorkspace", commandId: "inspect-workspace" }] }
  expect(moduleHostCommand("inspectWorkspace", [module])).toBe("inspect-workspace")
  expect(() => moduleHostCommand("missing", [module])).toThrow("requires one module declaration, found 0")
  expect(() => moduleHostCommand("inspectWorkspace", [module, { ...module, id: "mcp" }])).toThrow("requires one module declaration, found 2")
  expect(moduleHostCommand("drainPapercuts")).toBe("papercuts")
})

/** A module no table names: one workspace domain and one session domain
 *  with a background codec and an omitted editor exposure. */
interface Tally { readonly total: number }
interface TallySnapshot { readonly snapshotPosition: number; readonly tally: Tally }
type TallyPatch = { readonly kind: "tally.changed"; readonly tally: Tally }
interface Ledger { readonly rows: readonly string[] }
interface LedgerSnapshot { readonly snapshotPosition: number; readonly ledger: Ledger | null }
type LedgerPatch = { readonly kind: "ledger.updated"; readonly ledger: Ledger } | { readonly kind: "ledger.removed" }

const TallySchema: Schema.Codec<Tally> = Schema.Struct({ total: Schema.Number })
const TallySnapshotSchema: Schema.Codec<TallySnapshot> = Schema.Struct({ snapshotPosition: Schema.Number, tally: TallySchema })
const TallyPatchSchema: Schema.Codec<TallyPatch> = Schema.Struct({ kind: Schema.Literal("tally.changed"), tally: TallySchema })
const LedgerSchema: Schema.Codec<Ledger> = Schema.Struct({ rows: Schema.Array(Schema.String) })
const LedgerSnapshotSchema: Schema.Codec<LedgerSnapshot> = Schema.Struct({ snapshotPosition: Schema.Number, ledger: Schema.NullOr(LedgerSchema) })
const LedgerBackgroundSchema: Schema.Codec<{ readonly ledger: Ledger | null }> = Schema.Struct({ ledger: Schema.NullOr(LedgerSchema) })
const LedgerPatchSchema: Schema.Codec<LedgerPatch> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ledger.updated"), ledger: LedgerSchema }),
  Schema.Struct({ kind: Schema.Literal("ledger.removed") }),
])

/** A read that is not a snapshot, and one user mutation, beside the domains. */
const tallyHistory = defineProtocolQuery({ query: "tallyHistory", input: { limit: Schema.Number }, result: Schema.Struct({ totals: Schema.Array(Schema.Number) }), deadline: "output", editor: "omitted" })
const tallyReset = defineProtocolMutation({ type: "tally.reset", fields: { reason: Schema.String }, result: Schema.Struct({ ok: Schema.Literal(true), total: Schema.Number }), policy: "lossless" })

const syntheticProtocol = defineProtocolModule({
  id: "development",
  queries: [tallyHistory],
  mutations: [tallyReset],
  domains: [
    defineProtocolDomain({
      domain: "tally",
      scope: "workspace",
      delivery: "latest-collapsible",
      content: "whole-value",
      snapshot: { query: "tallySnapshot", result: TallySnapshotSchema, deadline: "control" },
      patch: TallyPatchSchema,
      view: { snapshot: (result) => result.tally, patch: (payload) => payload.tally },
    }),
    defineProtocolDomain({
      domain: "ledger",
      scope: "session",
      delivery: "durable-resnapshot",
      content: "change",
      snapshot: { query: "ledgerSnapshot", input: { limit: Schema.Number }, result: LedgerSnapshotSchema, deadline: "output", background: LedgerBackgroundSchema },
      patch: LedgerPatchSchema,
      view: { snapshot: (result) => result.ledger, patch: (payload) => payload.kind === "ledger.updated" ? payload.ledger : null },
      editor: "omitted",
    }),
  ],
})
const registry = [syntheticProtocol] as const satisfies readonly ProtocolModule[]
const domains = protocolDomains(registry)
const reads = protocolReads(registry)
const mutations = protocolMutations(registry)
type SyntheticDomain = ProtocolDomainOf<typeof registry>
type SyntheticQuery = ProtocolQueryOf<typeof registry>
type SyntheticMutation = ProtocolMutationOf<typeof registry>

// The types the tables are keyed by derive from the declaration alone.
type _Queries = Assert<Equal<ProtocolDomainQuery<SyntheticDomain>["type"], "tallySnapshot" | "ledgerSnapshot">>
type _LedgerQuery = Assert<Equal<Extract<ProtocolDomainQuery<SyntheticDomain>, { readonly type: "ledgerSnapshot" }>, { readonly type: "ledgerSnapshot" } & { readonly sessionId: string } & { readonly limit: number }>>
type _TallyQuery = Assert<Equal<Extract<ProtocolDomainQuery<SyntheticDomain>, { readonly type: "tallySnapshot" }>, { readonly type: "tallySnapshot" }>>
type _Snapshots = Assert<Equal<ProtocolDomainSnapshot<SyntheticDomain>, TallySnapshot | LedgerSnapshot>>
type _Patches = Assert<Equal<ProtocolDomainPatch<SyntheticDomain>, TallyPatch | LedgerPatch>>
type _Views = Assert<Equal<ProtocolDomainView<Extract<SyntheticDomain, { readonly domain: "ledger" }>>, Ledger>>
type _SessionNames = Assert<Equal<Extract<SyntheticDomain, { readonly scope: "session" }>["domain"], "ledger">>
type _Reads = Assert<Equal<(typeof reads)[number]["query"], "tallySnapshot" | "ledgerSnapshot" | "tallyHistory">>
type _QueryRequest = Assert<Equal<ProtocolQueryRequest<SyntheticQuery>, { readonly type: "tallyHistory" } & { readonly limit: number }>>
type _QueryResult = Assert<Equal<ProtocolQueryResult<SyntheticQuery>, { readonly totals: readonly number[] }>>
type _MutationRequest = Assert<Equal<ProtocolMutationRequest<SyntheticMutation>, { readonly type: "tally.reset" } & { readonly reason: string }>>
type _MutationResult = Assert<Equal<ProtocolMutationResult<SyntheticMutation>, { readonly ok: true; readonly total: number }>>
const derived: [_Queries, _LedgerQuery, _TallyQuery, _Snapshots, _Patches, _Views, _SessionNames, _Reads, _QueryRequest, _QueryResult, _MutationRequest, _MutationResult] = [true, true, true, true, true, true, true, true, true, true, true, true]

// The shipped routes accept only the registry's request unions, which cannot
// name a synthetic module. A decoded client request reaches them by
// discriminant alone, so each helper erases its request type at that one
// call, and its caller sends exactly what the synthetic declaration derives.
function syntheticServe(routes: ModuleProtocolRoutes, query: ProtocolQueryRequest<SyntheticQuery>): Promise<ProtocolQueryResult<SyntheticQuery>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: no typed request exists for a contract outside the shipped registry
  return routes.serve(query as never)
}
function syntheticMutate(routes: ModuleProtocolRoutes, mutation: ProtocolMutationRequest<SyntheticMutation> | { readonly type: "unknown.mutation" }): Promise<ProtocolMutationResult<SyntheticMutation>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: no typed request exists for a contract outside the shipped registry
  return routes.mutate(mutation as never)
}

describe("protocol module registry composition", () => {
  test("a synthetic module composes into the query, result, patch, cursor, delivery, deadline, background, and coverage tables with no table edit", () => {
    expect(derived).toEqual([true, true, true, true, true, true, true, true, true, true, true, true])

    const QuerySchema = Schema.Union(reads.map((read) => protocolReadSchema<unknown>(read)))
    expect(Schema.decodeUnknownSync(QuerySchema)({ type: "tallySnapshot" })).toEqual({ type: "tallySnapshot" })
    expect(Schema.decodeUnknownSync(QuerySchema)({ type: "ledgerSnapshot", sessionId: "s1", limit: 3 })).toEqual({ type: "ledgerSnapshot", sessionId: "s1", limit: 3 })
    expect(Schema.decodeUnknownSync(QuerySchema)({ type: "tallyHistory", limit: 3 })).toEqual({ type: "tallyHistory", limit: 3 })
    expect(() => Schema.decodeUnknownSync(QuerySchema)({ type: "ledgerSnapshot", limit: 3 })).toThrow()
    expect(() => Schema.decodeUnknownSync(QuerySchema)({ type: "ledgerSnapshot", sessionId: "s1" })).toThrow()
    expect(() => Schema.decodeUnknownSync(QuerySchema)({ type: "tallyHistory" })).toThrow()
    expect(() => Schema.decodeUnknownSync(QuerySchema)({ type: "nope" })).toThrow()

    const MutationSchema = Schema.Union(mutations.map((mutation) => protocolMutationSchema<unknown>(mutation)))
    expect(Schema.decodeUnknownSync(MutationSchema)({ type: "tally.reset", reason: "fresh" })).toEqual({ type: "tally.reset", reason: "fresh" })
    expect(() => Schema.decodeUnknownSync(MutationSchema)({ type: "tally.reset" })).toThrow()

    const results = protocolQueryTable(reads, (read) => read.result)
    const tally = { snapshotPosition: 4, tally: { total: 2 } }
    const ledger = { snapshotPosition: 5, ledger: { rows: ["a"] } }
    expect(Schema.decodeUnknownSync(results.tallySnapshot)(tally)).toEqual(tally)
    expect(Schema.decodeUnknownSync(results.ledgerSnapshot)(ledger)).toEqual(ledger)
    expect(Schema.decodeUnknownSync(results.tallyHistory)({ totals: [1, 2] })).toEqual({ totals: [1, 2] })
    expect(() => Schema.decodeUnknownSync(results.tallySnapshot)(ledger)).toThrow()
    expect(protocolMutationTable(mutations, (mutation) => mutation.policy)).toEqual({ "tally.reset": "lossless" })

    const PatchSchema = Schema.Union(domains.map((domain) => domain.patch))
    expect(Schema.decodeUnknownSync(PatchSchema)({ kind: "tally.changed", tally: { total: 1 } })).toEqual({ kind: "tally.changed", tally: { total: 1 } })
    expect(Schema.decodeUnknownSync(PatchSchema)({ kind: "ledger.removed" })).toEqual({ kind: "ledger.removed" })
    expect(() => Schema.decodeUnknownSync(PatchSchema)({ kind: "ledger.updated" })).toThrow()

    const SessionDomains = Schema.Literals([...KERNEL_SESSION_DOMAINS, ...protocolDomainNames(domains, "session")])
    const WorkspaceDomains = Schema.Literals([...KERNEL_WORKSPACE_DOMAINS, ...protocolDomainNames(domains, "workspace")])
    expect(Schema.decodeUnknownSync(SessionDomains)("ledger")).toBe("ledger")
    expect(() => Schema.decodeUnknownSync(SessionDomains)("tally")).toThrow()
    expect(Schema.decodeUnknownSync(WorkspaceDomains)("tally")).toBe("tally")

    expect(protocolDomainTable(domains, (domain) => domain.delivery)).toEqual({ tally: "latest-collapsible", ledger: "durable-resnapshot" })
    expect(protocolQueryTable(reads, (read) => read.deadline)).toEqual({ tallySnapshot: "control", ledgerSnapshot: "output", tallyHistory: "output" })
    expect(protocolBackgroundDomains(domains).map((domain) => domain.domain)).toEqual(["ledger"])
    expect(protocolQueryTable(reads, (read) => read.editor === "omitted" ? "omitted" : "exposed")).toEqual({ tallySnapshot: "exposed", ledgerSnapshot: "omitted", tallyHistory: "omitted" })
    expect(protocolMutationTable(mutations, (mutation) => mutation.editor === "omitted" ? "omitted" : "exposed")).toEqual({ "tally.reset": "exposed" })
  })

  test("recursive union composition exposes each synthetic module patch variant as a direct member", () => {
    const PatchSchema = Schema.Union(domains.map((domain) => domain.patch))
    const members = recursiveUnionMembers(PatchSchema)
    expect(stringDiscriminatorLiterals(PatchSchema, "kind")).toEqual([
      "tally.changed",
      "ledger.updated",
      "ledger.removed",
    ])
    expect(members).toHaveLength(3)
  })

  test("a synthetic module's query and mutation route to its protocol runtime by discriminant with no host edit", async () => {
    const served: string[] = []
    const runtime = (): ModuleProtocolRuntime<typeof syntheticProtocol> => ({
      serve: {
        tallySnapshot: async () => { served.push("tallySnapshot"); return { snapshotPosition: 1, tally: { total: 2 } } },
        ledgerSnapshot: async ({ sessionId, limit }) => { served.push(`ledgerSnapshot:${sessionId}:${limit}`); return { snapshotPosition: 2, ledger: null } },
        tallyHistory: async ({ limit }) => { served.push(`tallyHistory:${limit}`); return { totals: [limit] } },
      },
      mutate: {
        "tally.reset": async ({ reason }) => { served.push(`tally.reset:${reason}`); return { ok: true, total: 0 } },
      },
      dispose() {},
    })
    const background = (): ModuleBackgroundReaders<typeof syntheticProtocol> => ({ ledger: async () => ({ ledger: null }) })
    const syntheticModule = {
      id: "development",
      dependencies: [],
      availability: { kind: "available" },
      // The runtime and readers above are typed against their own contract; only the erasure into a contribution is unchecked, because `moduleProtocol` accepts only a contract of the shipped registry and this one is outside it by design.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: no typed erasure exists for a contract outside the shipped registry
      protocol: { contract: syntheticProtocol, create: runtime, background } as never,
      contributions: [],
      observers: [],
      transformers: [],
      gates: [],
    } as const satisfies FirstPartyModule
    const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
    const routes = composeModuleProtocolRuntimes([syntheticModule], {
      eventStore: reader,
      projectionReader: reader,
      eventWriter: { append: async () => { throw new Error("No synthetic fact write") }, appendBatch: async () => { throw new Error("No synthetic fact write") }, pruneSupersededEvents: async () => 0 },
      manager: fakeManager(),
      sessionStore: fakeSessionStore(new Map()),
      definitions: repoDefinitions(),
      onStored: () => () => {},
      publish: () => undefined,
      snapshotPosition: () => 0,
      hasLiveSession: () => false,
      background: async () => { throw new Error("The synthetic module reads no background history") },
      modules: NO_MODULE_SERVICES,
      interruptSession: async () => false,
    }, () => ["development"])
    expect(await syntheticServe(routes, { type: "tallyHistory", limit: 3 })).toEqual({ totals: [3] })
    expect(await syntheticMutate(routes, { type: "tally.reset", reason: "fresh" })).toEqual({ ok: true, total: 0 })
    expect(served).toEqual(["tallyHistory:3", "tally.reset:fresh"])
    expect(() => syntheticMutate(routes, { type: "unknown.mutation" })).toThrow("No installed module handles unknown.mutation")
  })

  test("the shipped registry reaches every table", () => {
    type ModuleIntake = Assert<Equal<Pick<RuntimeDomainIntakeBindings, "experiment_view" | "papercuts">, { readonly experiment_view: object; readonly papercuts: object }>>
    type ExperimentResult = Assert<Equal<RuntimeQueryResult<{ readonly type: "experimentViewSnapshot"; readonly sessionId: string }>, RuntimeExperimentViewSnapshotResult>>
    const shipped: [ModuleIntake, ExperimentResult] = [true, true]
    expect(shipped).toEqual([true, true])

    const query = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    if (query === undefined) throw new Error("RuntimeQuery is missing")
    expect(Schema.decodeUnknownSync(query.payloadSchema)({ type: "papercutCountSnapshot" })).toEqual({ type: "papercutCountSnapshot" })
    expect(Schema.decodeUnknownSync(query.payloadSchema)({ type: "experimentViewSnapshot", sessionId: "s1" })).toEqual({ type: "experimentViewSnapshot", sessionId: "s1" })
    expect(() => Schema.decodeUnknownSync(query.payloadSchema)({ type: "unknownSnapshot" })).toThrow()

    expect(Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)({ scope: "session", domain: "experiment_view", sessionId: "s1" })).toEqual({ scope: "session", domain: "experiment_view", sessionId: "s1" })
    expect(Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)({ scope: "workspace", domain: "papercuts" })).toEqual({ scope: "workspace", domain: "papercuts" })
    expect(runtimeDeliveryPolicy("experiment_view")).toBe("durable-resnapshot")
    expect(runtimeDeliveryPolicy("papercuts")).toBe("latest-collapsible")
    expect(runtimeCallPolicies.experimentViewSnapshot).toEqual(runtimeCallPolicies.statusSnapshot)
    expect(runtimeCallPolicies.papercutCountSnapshot).toEqual(runtimeCallPolicies.statusSnapshot)
    expect(PROTOCOL_BACKGROUND_DOMAINS).toEqual(["experiment_view", "workflow_detail", "workflow_view", "workflow_live"])
    expect(Schema.decodeUnknownSync(protocolBackgroundSchema("experiment_view"))({ experimentView: null })).toEqual({ experimentView: null })
    const patch: RuntimeUiPatch = { cursor: { scope: "workspace", domain: "papercuts" }, position: 2, prevPosition: 1, payload: { kind: "papercuts.changed", papercuts: { undisposedCount: 1 } } }
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
    expect(MODULE_DOMAIN_BINDINGS.papercuts.cursor()).toEqual({ scope: "workspace", domain: "papercuts" })
    expect(MODULE_DOMAIN_BINDINGS.experiment_view.cursor("s1")).toEqual({ scope: "session", domain: "experiment_view", sessionId: "s1" })
  })

  test("a query result decodes with the codec its discriminant selects, never by structural first match", () => {
    const papercuts = { snapshotPosition: 1, papercuts: { undisposedCount: 2 } }
    expect(Schema.decodeUnknownSync(runtimeQueryResultSchema("papercutCountSnapshot"))(papercuts)).toEqual(papercuts)
    expect(() => Schema.decodeUnknownSync(runtimeQueryResultSchema("experimentViewSnapshot"))(papercuts)).toThrow()
    // A result whose declared codec has only optional fields no longer claims foreign objects: it is reached only by its own discriminant.
    expect(() => Schema.decodeUnknownSync(runtimeQueryResultSchema("modelRoles"))(papercuts)).toThrow()
    const query = RuntimeProtocolRpc.requests.get("RuntimeQuery")
    if (query === undefined) throw new Error("RuntimeQuery is missing")
    // The wire carries the result opaque; both ends select the codec above.
    expect(Schema.decodeUnknownSync(query.successSchema)(papercuts)).toEqual(papercuts)
  })

  test("definition staleness snapshots and patches accept active families and refuse the retired workflow family", () => {
    const decodeSnapshot = Schema.decodeUnknownSync(runtimeQueryResultSchema("definitionStalenessSnapshot"))
    const decodePatch = Schema.decodeUnknownSync(RuntimeUiPatchSchema)
    for (const family of ["skill", "persona", "system-prompt", "workflow"]) {
      const view = {
        overrides: [{ family, id: "override", layer: "project", path: "/project/.flywheel/override", status: "upstream-changed", snapshotAvailable: true }],
        diagnostics: [],
        reviewCount: 1,
      }
      const snapshot = { snapshotPosition: 1, definitionStaleness: view }
      const patch = { cursor: { scope: "workspace", domain: "definitionStaleness" }, position: 2, prevPosition: 1, payload: { kind: "definitionStaleness.changed", definitionStaleness: view } }
      if (family === "workflow") {
        expect(() => decodeSnapshot(snapshot)).toThrow()
        expect(() => decodePatch(patch)).toThrow()
      } else {
        expect(decodeSnapshot(snapshot)).toEqual(snapshot)
        expect<unknown>(decodePatch(patch)).toEqual(patch)
      }
    }
  })

  test("a module query and its view fold are typed by the registry entry", async () => {
    const answered: RuntimeQuery[] = []
    const query = runtimeQuery({
      papercutCountSnapshot: async (request) => {
        answered.push(request)
        return { snapshotPosition: 3, papercuts: { undisposedCount: 5 } }
      },
    })
    const snapshot = await MODULE_DOMAIN_BINDINGS.papercuts.read({ query })
    expect(snapshot).toEqual({ snapshotPosition: 3, view: { undisposedCount: 5 } })
    expect(answered).toEqual([{ type: "papercutCountSnapshot" }])
    expect(MODULE_DOMAIN_BINDINGS.papercuts.isPayload({ kind: "papercuts.changed", papercuts: { undisposedCount: 1 } })).toBe(true)
    expect(MODULE_DOMAIN_BINDINGS.papercuts.isPayload({ kind: "experiment_view.removed" })).toBe(false)
    expect(MODULE_DOMAIN_BINDINGS.experiment_view.payloadView({ kind: "experiment_view.removed" }, undefined)).toBeNull()
    const raised = { id: "e1", sourceId: "s", title: "t", message: "m", severity: "warning" as const, action: { kind: "open-settings" as const }, createdAt: 1, expiresAt: 2 }
    expect(MODULE_DOMAIN_BINDINGS.project_notifications.payloadView({ kind: "project_notifications.raised", episode: raised }, [])).toEqual([raised])
    expect(MODULE_DOMAIN_BINDINGS.project_notifications.payloadView({ kind: "project_notifications.resolved", sourceId: "s", episodeId: "e1", resolvedAt: 3 }, [raised])).toEqual([{ ...raised, resolvedAt: 3 }])
  })
})
