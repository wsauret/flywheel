import { Schema } from "effect"
import type { ModuleId } from "./module-ids.js"
import type { RuntimeDeliveryPolicy, RuntimeDomainDelivery, RuntimePatchContent, RuntimePosition } from "./runtime-ui-protocol-types.js"

/** The generic contract a module's runtime UI protocol is declared against.
 *
 *  A domain is one cursor the runtime publishes patches on. It is complete
 *  when its module states the scope, the delivery policy, the patch content,
 *  the snapshot query
 *  with its result codec and deadline tier, the patch codec, and the fold that
 *  reads the domain's view out of a snapshot or a patch. A query is a read
 *  that is not a snapshot: it has no cursor and no view. A mutation is a user
 *  action the module answers. The registry in `modules.ts` composes every
 *  protocol table from these declarations, so a module adds a domain, a
 *  query, or a mutation without editing a table; every derivation below is a
 *  pure type over the declaration, which is what keeps the tables and the
 *  client intake compile-time coupled (ARCH-PROTOCOL-010). */

/** Every snapshot result carries the position it covers. */
interface ProtocolSnapshotResult {
  readonly snapshotPosition: RuntimePosition
}

/** The background Worker serves durable history and mints no position. */
export type BackgroundSnapshotOf<Snapshot extends ProtocolSnapshotResult> = Snapshot extends unknown ? Omit<Snapshot, "snapshotPosition"> : never

export interface ProtocolSnapshotSpec<Query extends string, Input extends Schema.Struct.Fields, Snapshot extends ProtocolSnapshotResult> {
  readonly query: Query
  /** Query input fields beyond `type` and, for session scope, `sessionId`. */
  readonly input?: Input
  readonly result: Schema.Codec<Snapshot>
  /** The client deadline tier: control reads are short, output reads are sized for history. */
  readonly deadline: "control" | "output"
  /** A session-scoped domain served from durable history when the session is not live. */
  readonly background?: Schema.Codec<BackgroundSnapshotOf<Snapshot>>
}

/** How a client reads the domain's view: `null` means the domain has no view
 *  for that cursor, which for a patch is the domain's removal kind. A patch
 *  fold receives the view the client holds, so a fact-shaped patch can fold
 *  into it; a patch that carries the whole view ignores it. */
interface ProtocolViewFold<Snapshot, Patch, View> {
  snapshot(result: Snapshot): View | null
  patch(payload: Patch, current: View | undefined): View | null
}

export interface ProtocolDomain<
  Domain extends string,
  Scope extends "session" | "workspace" | "workflow",
  Spec extends ProtocolSnapshotSpec<string, Schema.Struct.Fields, Snapshot>,
  Snapshot extends ProtocolSnapshotResult,
  Patch extends { readonly kind: string },
  View,
> {
  readonly domain: Domain
  readonly scope: Scope
  readonly delivery: RuntimeDeliveryPolicy
  /** Whether each patch states the cursor's whole value or a change; a
   *  latest-collapsible domain states a whole value. */
  readonly content: RuntimePatchContent
  readonly snapshot: Spec
  readonly patch: Schema.Codec<Patch>
  readonly view: ProtocolViewFold<Snapshot, Patch, View>
  /** The view as a client may show it while the runtime does not answer.
   *  A client holds the runtime's last view through an outage; a domain
   *  whose view claims what holds right now, such as an attachment, states
   *  here what of it no reader may claim until the runtime answers again. */
  unanswered?(view: View): View
  /** The editor host omits this domain from its client when set. Default exposed. */
  readonly editor?: "omitted"
}

export type AnyProtocolDomain = ProtocolDomain<string, "session" | "workspace" | "workflow", ProtocolSnapshotSpec<string, Schema.Struct.Fields, ProtocolSnapshotResult>, ProtocolSnapshotResult, { readonly kind: string }, unknown>

/** A read the module answers that is not a domain snapshot: it carries no
 *  cursor and no session scope of its own, so a session id it needs is one of
 *  its declared input fields. */
export interface ProtocolQuery<Query extends string, Input extends Schema.Struct.Fields, Result> {
  readonly query: Query
  readonly input?: Input
  readonly result: Schema.Codec<Result>
  readonly deadline: "control" | "output"
  /** The editor host omits this query from its client when set. Default exposed. */
  readonly editor?: "omitted"
}

type AnyProtocolQuery = ProtocolQuery<string, Schema.Struct.Fields, unknown>

/** A user mutation the module answers. `policy` is the call class of ARCH-PROTOCOL-020:
 *  a user action is lossless, and a call a client may repeat is retryable
 *  under the control deadline. */
export interface ProtocolMutation<Type extends string, Fields extends Schema.Struct.Fields, Result> {
  readonly type: Type
  readonly fields: Fields
  readonly result: Schema.Codec<Result>
  readonly policy: "lossless" | "retryable"
  /** Closed admission answers through the module's result codec when its
   *  refusal differs from the standard { ok: false, error } result. */
  readonly refuse?: (message: string) => Result
  /** The editor host omits this mutation from its client when set. Default exposed. */
  readonly editor?: "omitted"
}

export type AnyProtocolMutation = ProtocolMutation<string, Schema.Struct.Fields, unknown>

/** What a declarative row does when the user picks it: run a runtime command
 *  by its catalog id, or open a client surface by its id. */
export type ModuleRowAction =
  | { readonly kind: "command"; readonly id: string }
  | { readonly kind: "surface"; readonly id: string }

/** One row a module contributes to a client's intro card, status surface, or
 *  Settings.
 *  Both clients render rows from this one description, so a module states a
 *  fact once and never draws it twice. */
export interface ModuleRow {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly hint?: string
  readonly tone?: "warning"
  readonly action?: ModuleRowAction
}

/** A module's label in composer chrome. The optional suffix carries separately
 *  styled status metadata and participates in the host's width calculation. */
export interface ModuleComposerStatus {
  readonly id: string
  readonly text: string
  readonly tone?: "warning" | "success"
  readonly suffix?: { readonly text: string; readonly tone?: "warning" | "success" }
  readonly action?: ModuleRowAction
}

/** The client's current view of one registry domain: the workspace view, or
 *  the foreground session's view for session scope. Undefined before the first
 *  snapshot lands and where the session has none. */
export type DomainReader = <D extends AnyProtocolDomain>(domain: D) => ProtocolDomainView<D> | undefined

/** Pure selectors over the module's own views. Each answers the rows for one
 *  client slot; an absent selector contributes no row to that slot. */
interface ProtocolModuleRows {
  readonly intro?: (read: DomainReader) => readonly ModuleRow[]
  readonly status?: (read: DomainReader) => readonly ModuleRow[]
  /** The module's rows at the setting catalog's client-modules slot, which
   *  every client's Settings shows in the same place (ARCH-PROTOCOL-066). */
  readonly settings?: (read: DomainReader) => readonly ModuleRow[]
}

export type ModuleRowSlot = keyof ProtocolModuleRows

export interface ProtocolModule {
  readonly id: ModuleId
  readonly domains: readonly AnyProtocolDomain[]
  readonly queries?: readonly AnyProtocolQuery[]
  readonly mutations?: readonly AnyProtocolMutation[]
  readonly rows?: ProtocolModuleRows
  readonly composer?: { readonly status: (read: DomainReader, surface?: "terminal" | "webview") => readonly ModuleComposerStatus[] }
  /** Stable host integration keys resolve to this module's command vocabulary. */
  readonly hostCommands?: readonly { readonly key: string; readonly commandId: string }[]
}

/** The literal types of the domain name, scope, query, and snapshot spec
 *  survive this call, and the snapshot and patch types are read from the
 *  codecs, so the view fold's parameters are typed by the domain's own
 *  contract rather than the loose base. */
export function defineProtocolDomain<
  const Domain extends string,
  const Scope extends "session" | "workspace" | "workflow",
  const Spec extends ProtocolSnapshotSpec<string, Schema.Struct.Fields, Snapshot>,
  Snapshot extends ProtocolSnapshotResult,
  Patch extends { readonly kind: string },
  View,
>(
  domain: ProtocolDomain<Domain, Scope, Spec, Snapshot, Patch, View> & RuntimeDomainDelivery & { readonly snapshot: { readonly result: Schema.Codec<Snapshot> } },
): ProtocolDomain<Domain, Scope, Spec, Snapshot, Patch, View> {
  return domain
}

/** Keeps the declaration's own type, as `defineProtocolDomain` does, so a
 *  declared `input` stays a required member the request type can read. */
export function defineProtocolQuery<const Q extends ProtocolQuery<string, Schema.Struct.Fields, Result>, Result>(query: Q & { readonly result: Schema.Codec<Result> }): Q {
  return query
}

export function defineProtocolMutation<const Type extends string, const Fields extends Schema.Struct.Fields, Result>(mutation: ProtocolMutation<Type, Fields, Result>): ProtocolMutation<Type, Fields, Result> {
  return mutation
}

export function defineProtocolModule<const M extends ProtocolModule>(module: M): M {
  return module
}

/** The wire query one domain's snapshot answers: the discriminant, the session
 *  id for session scope, and the declared input fields. Distributive, so a
 *  union of domains yields a union of queries. */
export type ProtocolDomainQuery<D extends AnyProtocolDomain> = D extends unknown
  ? { readonly type: D["snapshot"]["query"] }
    & (D["scope"] extends "session" ? { readonly sessionId: string } : D["scope"] extends "workflow" ? { readonly workflowId: string } : unknown)
    & (D["snapshot"] extends { readonly input: infer Input extends Schema.Struct.Fields } ? Schema.Struct.Type<Input> : unknown)
  : never
export type ProtocolDomainSnapshot<D extends AnyProtocolDomain> = D["snapshot"]["result"]["Type"]
export type ProtocolDomainPatch<D extends AnyProtocolDomain> = D["patch"]["Type"]
export type ProtocolDomainView<D extends AnyProtocolDomain> = NonNullable<ReturnType<D["view"]["snapshot"]>>
export type ProtocolDomainOf<Modules extends readonly ProtocolModule[]> = Modules[number]["domains"][number]
type ProtocolBackgroundDomainOf<D extends AnyProtocolDomain> = Extract<D, { readonly snapshot: { readonly background: Schema.Top } }>

/** The wire request one module query answers: the discriminant and the
 *  declared input fields. Distributive over a union of queries. */
export type ProtocolQueryRequest<Q extends AnyProtocolQuery> = Q extends unknown
  ? { readonly type: Q["query"] } & (Q extends { readonly input: infer Input extends Schema.Struct.Fields } ? Schema.Struct.Type<Input> : unknown)
  : never
export type ProtocolQueryResult<Q extends AnyProtocolQuery> = Q["result"]["Type"]
/** A module that declares no queries contributes none; the conditional
 *  distributes over the registry's module union. */
type DeclaredQueries<M> = M extends { readonly queries: readonly AnyProtocolQuery[] } ? M["queries"][number] : never
export type ProtocolQueryOf<Modules extends readonly ProtocolModule[]> = DeclaredQueries<Modules[number]>

/** The wire mutation one module mutation answers: the type literal beside the declared fields. */
export type ProtocolMutationRequest<M extends AnyProtocolMutation> = M extends unknown ? { readonly type: M["type"] } & Schema.Struct.Type<M["fields"]> : never
export type ProtocolMutationResult<M extends AnyProtocolMutation> = M["result"]["Type"]
type DeclaredMutations<M> = M extends { readonly mutations: readonly AnyProtocolMutation[] } ? M["mutations"][number] : never
export type ProtocolMutationOf<Modules extends readonly ProtocolModule[]> = DeclaredMutations<Modules[number]>

/** One wire read as the registry tables see it: a domain's snapshot query
 *  beside its scope, or a module's own query. Only the discriminant survives
 *  at the type level; the request and result unions derive from the
 *  declarations themselves. */
export interface ProtocolRead<Query extends string> {
  readonly query: Query
  readonly input?: Schema.Struct.Fields
  readonly result: Schema.Codec<unknown>
  readonly deadline: "control" | "output"
  readonly editor?: "omitted"
  /** A session-scoped snapshot carries the session id beside its declared input. */
  readonly session: boolean
  readonly workflow?: boolean
}

/** Every domain of a registry, in registry order. */
export function protocolDomains<const Modules extends readonly ProtocolModule[]>(modules: Modules): readonly ProtocolDomainOf<Modules>[] {
  return modules.flatMap((module): readonly ProtocolDomainOf<Modules>[] => module.domains)
}

/** Every module query of a registry, in registry order. */
function protocolQueries<const Modules extends readonly ProtocolModule[]>(modules: Modules): readonly ProtocolQueryOf<Modules>[] {
  const declared: readonly ProtocolModule[] = modules
  const queries: unknown = declared.flatMap((module) => module.queries ?? [])
  // SAFETY: each module's `queries` array is exactly what `DeclaredQueries` reads from that module's literal type; the base type erases the per-module literal.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry composition over the base contract
  return queries as readonly ProtocolQueryOf<Modules>[]
}

/** Every module mutation of a registry, in registry order. */
export function protocolMutations<const Modules extends readonly ProtocolModule[]>(modules: Modules): readonly ProtocolMutationOf<Modules>[] {
  const declared: readonly ProtocolModule[] = modules
  const mutations: unknown = declared.flatMap((module) => module.mutations ?? [])
  // SAFETY: each module's `mutations` array is exactly what `DeclaredMutations` reads from that module's literal type; the base type erases the per-module literal.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry composition over the base contract
  return mutations as readonly ProtocolMutationOf<Modules>[]
}

/** Every read of a registry: each domain's snapshot query, then each module query. */
export function protocolReads<const Modules extends readonly ProtocolModule[]>(modules: Modules): readonly ProtocolRead<ProtocolDomainOf<Modules>["snapshot"]["query"] | ProtocolQueryOf<Modules>["query"]>[] {
  return [
    ...protocolDomains(modules).map((domain) => ({ ...domain.snapshot, ...(domain.editor === undefined ? {} : { editor: domain.editor }), session: domain.scope === "session", workflow: domain.scope === "workflow" })),
    ...protocolQueries(modules).map((query) => ({ ...query, session: false })),
  ]
}

/** The rows every module of a registry contributes to one slot, in registry order. */
export function protocolModuleRows(modules: readonly ProtocolModule[], slot: ModuleRowSlot, read: DomainReader, enabled?: readonly ModuleId[]): readonly ModuleRow[] {
  return modules.flatMap((module) => enabled === undefined || enabled.includes(module.id) ? module.rows?.[slot]?.(read) ?? [] : [])
}

/** The names of a registry's domains with one scope. */
export function protocolDomainNames<D extends AnyProtocolDomain, Scope extends "session" | "workspace" | "workflow">(domains: readonly D[], scope: Scope): readonly Extract<D, { readonly scope: Scope }>["domain"][] {
  return domains
    .filter((domain): domain is Extract<D, { readonly scope: Scope }> => domain.scope === scope)
    .map((domain) => domain.domain)
}

/** The domains a background Worker can answer from durable history. */
export function protocolBackgroundDomains<D extends AnyProtocolDomain>(domains: readonly D[]): readonly ProtocolBackgroundDomainOf<D>[] {
  return domains.filter((domain): domain is ProtocolBackgroundDomainOf<D> => domain.snapshot.background !== undefined)
}

/** The wire codec of one read's request, typed by the registry's request union. */
export function protocolReadSchema<Request>(read: ProtocolRead<string>): Schema.Codec<Request> {
  const fields = { type: Schema.Literal(read.query), ...read.input }
  const erased: Schema.Codec<unknown> = read.session ? Schema.Struct({ ...fields, sessionId: Schema.String }) : read.workflow ? Schema.Struct({ ...fields, workflowId: Schema.String }) : Schema.Struct(fields)
  // SAFETY: the struct is built field for field from the same declaration `ProtocolDomainQuery` and `ProtocolQueryRequest` read; the compiler cannot relate a spread of runtime-conditional fields to the mapped type.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed wire codec, checked by the registry test against the derived request type
  return erased as Schema.Codec<Request>
}

/** The wire codec of one mutation's request, typed by the registry's mutation union. */
export function protocolMutationSchema<Request>(mutation: AnyProtocolMutation): Schema.Codec<Request> {
  const erased: Schema.Codec<unknown> = Schema.Struct({ type: Schema.Literal(mutation.type), ...mutation.fields })
  // SAFETY: the struct is the declared fields beside the type literal, which is exactly what `ProtocolMutationRequest` reads from the declaration.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed wire codec, checked by the registry test against the derived request type
  return erased as Schema.Codec<Request>
}

/** A table keyed by every read discriminant of `reads`. */
export function protocolQueryTable<R extends ProtocolRead<string>, Value>(reads: readonly R[], select: (read: R) => Value): { readonly [Query in R["query"]]: Value } {
  // SAFETY: one entry per read under that read's own discriminant is exactly the mapped type; `Object.fromEntries` erases the key set.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed table
  return Object.fromEntries(reads.map((read) => [read.query, select(read)])) as { readonly [Query in R["query"]]: Value }
}

/** A table keyed by every mutation type of `mutations`. */
export function protocolMutationTable<M extends AnyProtocolMutation, Value>(mutations: readonly M[], select: (mutation: M) => Value): { readonly [Type in M["type"]]: Value } {
  // SAFETY: one entry per mutation under its own type literal is exactly the mapped type; `Object.fromEntries` erases the key set.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed table
  return Object.fromEntries(mutations.map((mutation) => [mutation.type, select(mutation)])) as { readonly [Type in M["type"]]: Value }
}

/** A table keyed by every domain name of `domains`. */
export function protocolDomainTable<D extends AnyProtocolDomain, Value>(domains: readonly D[], select: (domain: D) => Value): { readonly [Name in D["domain"]]: Value } {
  // SAFETY: one entry per domain under its own name is exactly the mapped type; `Object.fromEntries` erases the key set.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed table
  return Object.fromEntries(domains.map((domain) => [domain.domain, select(domain)])) as { readonly [Name in D["domain"]]: Value }
}

/** Composer chrome from enabled modules, preserving registry order. */
export function protocolModuleComposerStatus(modules: readonly ProtocolModule[], read: DomainReader, enabled?: readonly ModuleId[], surface: "terminal" | "webview" = "terminal"): readonly ModuleComposerStatus[] {
  return modules.flatMap((module) => enabled === undefined || enabled.includes(module.id) ? module.composer?.status(read, surface) ?? [] : [])
}
