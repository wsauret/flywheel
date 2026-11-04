import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import type { EffortOptionRow, ModelOptionRow } from "../../../../src/protocol/model-assignment-protocol-types.js"
import { actionKey } from "../../client/action-key.js"
import { isProfileModelRole } from "../../../../src/protocol/brief-role-id.js"
import { describeFailure } from "../../client/failure-message.js"
import { roleGroups, type ModelScope, type SeatGroup, type SeatRow } from "../../client/model-roles.js"
import { useClient } from "../client-context.js"
import { createModelCatalogRevision } from "../model-catalog.js"
import { ModelOptionDetail } from "./model-option-detail.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "./sheet.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** Which model does each job.
 *
 *  One surface for both scope tables: the first row names the scope and
 *  toggles it, so "set the defaults" and "override this session" are the same
 *  list with one switch, never two commands. Picking a role lists the models
 *  that role can use; picking a model asks for an effort when the model offers
 *  a choice, because effort travels with the model and the runtime is asked
 *  what is valid rather than the old value being carried over. */

interface ScopeOwner {
  readonly scope: ModelScope
  readonly key: string
}
type ScopedPage = {
  readonly owner: ScopeOwner
}
type Page =
  | { readonly kind: "roles" }
  | ({ readonly kind: "options"; readonly seat: SeatRow; readonly options: readonly ModelOptionRow[] } & ScopedPage)
  | ({ readonly kind: "effort"; readonly seat: SeatRow; readonly option: ModelOptionRow; readonly efforts: readonly EffortOptionRow[] } & ScopedPage)

export function ModelsSheet() {
  const client = useClient()
  const sessionId = createMemo(() => client.state().sessionId)
  const [scopeKind, setScopeKind] = createSignal<"defaults" | "session">(sessionId() === undefined ? "defaults" : "session")
  const scope = (): ModelScope => {
    const id = sessionId()
    return scopeKind() === "session" && id !== undefined ? { kind: "session", sessionId: id } : { kind: "defaults" }
  }
  const ownerKey = (current: ModelScope) => current.kind === "session" ? `session:${current.sessionId}` : "defaults"
  const initialScope = scope()
  const scopeOwner = createMemo<ScopeOwner>((previous) => {
    const current = scope()
    const key = ownerKey(current)
    return previous.key === key ? previous : { scope: current, key }
  }, { scope: initialScope, key: ownerKey(initialScope) })
  const [page, setPage] = createSignal<Page>({ kind: "roles" })
  const catalogRevision = createModelCatalogRevision(() => scopeOwner().scope)
  const seeded = createMemo(() => catalogRevision() !== undefined)
  const [generation, setGeneration] = createSignal(0)
  let navigation = 0
  let disposed = false
  onCleanup(() => { disposed = true; navigation += 1 })
  const reread = () => setGeneration((count) => count + 1)
  createEffect(on(scopeOwner, () => { navigation += 1; setPage({ kind: "roles" }) }, { defer: true }))

  const [table] = createResource(() => seeded() && ({ owner: scopeOwner(), generation: generation() }), async ({ owner }, previous): Promise<{
    owner: ScopeOwner; roleIds: readonly string[]; groups: readonly SeatGroup[]
  }> => {
    const current = owner.scope
    try {
      const roles = await client.connection.query({ type: "modelRoles" })
      const assignments = await client.connection.query({ type: "modelAssignments", scope: current, slots: roles.roles.map((role) => ({ kind: "role" as const, roleId: role.id })) })
      return {
        owner,
        roleIds: roles.roles.map((role) => role.id),
        groups: roleGroups(roles.roles, assignments),
      }
    } catch (cause) {
      if (previous.value?.owner === owner) return previous.value
      throw cause
    }
  })
  const visibleTable = () => table.error === undefined && table.latest?.owner === scopeOwner() ? table.latest : undefined

  const failed = (verb: string) => (cause: unknown) => client.report("warning", `Flywheel could not ${verb}: ${describeFailure(cause)}`)
  const isCurrent = (owner: ScopeOwner) => !disposed && scopeOwner() === owner
  const failedFor = (owner: ScopeOwner, verb: string) => (cause: unknown) => {
    if (isCurrent(owner)) failed(verb)(cause)
  }
  createEffect(on(catalogRevision, (next, previous) => {
    // The initial snapshot starts the saved read through `seeded`; only later revisions reread it.
    if (next === undefined || previous === undefined) return
    const source = page()
    if (source.kind === "roles") { reread(); return }
    if (source.kind !== "options") return
    let active = true
    onCleanup(() => { active = false })
    void client.connection.query({ type: "modelOptions", scope: source.owner.scope, slot: { kind: "role", roleId: source.seat.roleId } })
      .then((options) => {
        if (active && page() === source && isCurrent(source.owner)) setPage({ ...source, options })
      })
      .catch(failedFor(source.owner, "refresh the models"))
  }, { defer: true }))

  // Every row works from its tap until the runtime answers it, and a second
  // tap joins the running read or write. Each read takes its navigation
  // number when it starts, inside the action, so a joining tap does not make
  // the running read stale.
  const seatKey = (seat: SeatRow) => actionKey("model-role", seat.roleId)
  const optionKey = (seat: SeatRow, option: ModelOptionRow) => actionKey("model-role", `${seat.roleId}:${option.model ?? ""}`)
  const effortKey = (seat: SeatRow, option: ModelOptionRow, effort: EffortOptionRow["effort"]) => actionKey("model-role", `${seat.roleId}:${option.model ?? ""}:${String(effort)}`)
  const resetKey = actionKey("model-reset")

  /** Reads a role's options and opens them. A catalog change during the read
   *  reads again inside the same action. */
  const readSeat = async (seat: SeatRow): Promise<void> => {
    const read = ++navigation
    const owner = scopeOwner()
    const revision = catalogRevision()
    try {
      const options = await client.connection.query({ type: "modelOptions", scope: owner.scope, slot: { kind: "role", roleId: seat.roleId } })
      if (!isCurrent(owner) || read !== navigation) return
      if (revision !== catalogRevision()) {
        await readSeat(seat)
        return
      }
      if (options.length === 0) {
        client.report("info", `No models are available for ${seat.label}.`)
        return
      }
      setPage({ kind: "options", seat, options, owner })
    } catch (cause) {
      failedFor(owner, "list the models")(cause)
    }
  }
  const openSeat = (seat: SeatRow) => { void client.actions.run(seatKey(seat), () => readSeat(seat)) }

  // Saves to one seat run in order, from this sheet or the chat model sheet,
  // so the last tap lands last.
  const save = (source: ScopedPage, seat: SeatRow, option: ModelOptionRow, effort: EffortOptionRow["effort"]): Promise<boolean> =>
    client.actions.runInOrder(actionKey("model-seat", seat.roleId), effortKey(seat, option, effort), () => {
      const read = ++navigation
      return client.connection.dispatch({ type: "model.save_effort", scope: source.owner.scope, slot: { kind: "role", roleId: seat.roleId }, model: option.model, effort })
        .then((result) => {
          if (result.warning) client.report("warning", result.warning)
          else client.report("info", `${seat.label}: ${result.label}`)
          if (isCurrent(source.owner) && read === navigation) setPage({ kind: "roles" })
          reread()
        })
        .catch(failed("change the model"))
    })

  const choose = (source: ScopedPage, seat: SeatRow, option: ModelOptionRow) => {
    if (!option.selectable) return
    void client.actions.run(optionKey(seat, option), () => {
      const read = ++navigation
      return client.connection.query({ type: "effortOptions", scope: source.owner.scope, slot: { kind: "role", roleId: seat.roleId }, model: option.model })
        .then(async (efforts) => {
          if (!isCurrent(source.owner) || read !== navigation) return
          const selectable = efforts.filter((entry) => entry.selectable)
          if (selectable.length > 1) {
            setPage({ kind: "effort", seat, option, efforts: selectable, owner: source.owner })
            return
          }
          await save(source, seat, option, selectable.find((entry) => entry.current)?.effort ?? selectable[0]?.effort ?? null)
        })
        .catch(failedFor(source.owner, "list the efforts"))
    })
  }

  const resetAll = () => {
    const current = table()
    if (!current) return
    const owner = scopeOwner()
    const session = owner.scope.kind === "session"
    const run = async () => {
      const confirmed = await client.confirm({
        title: session ? "Reset this session's roles?" : "Reset every role to its default model?",
        detail: session ? "Every override this session holds is dropped, and its roles inherit the defaults again." : "Each role returns to its configured default model and follows future default changes again.",
        confirmLabel: "Reset all",
        destructive: true,
      })
      if (!confirmed || !isCurrent(owner)) return
      await client.actions.run(resetKey, async () => {
        const result = await client.connection.dispatch({ type: "model.reset_assignments", scope: owner.scope, slots: current.roleIds.map((roleId) => ({ kind: "role" as const, roleId })) })
        if (!isCurrent(owner)) return
        if (result.warning) client.report("warning", result.warning)
        else client.report("info", session ? "This session's roles inherit the defaults again." : "Every role reset to its default.")
        reread()
      }, failedFor(owner, "reset the roles"))
    }
    void run().catch(failedFor(owner, "reset the roles"))
  }

  // Solid's Show narrows on what `when` returns, so each page kind gets an
  // accessor that returns it or nothing.
  const optionsPage = () => { const current = page(); return current.kind === "options" ? current : undefined }
  const effortPage = () => { const current = page(); return current.kind === "effort" ? current : undefined }

  const describeOption = (option: Accessor<ModelOptionRow>) => (
    <ModelOptionDetail
      providers={option().providers}
      parts={[option().tier, option().roleDefault === true ? "default" : undefined, option().inherit === true ? "inherit" : undefined, option().selectable ? undefined : option().reason ?? "unavailable"]}
    />
  )

  const title = () => {
    const current = page()
    switch (current.kind) {
      // The Models command's own name; the scope row under it says whose models these are.
      case "roles": return KERNEL_COMMAND_NAMES.model
      case "options": return `Model for ${current.seat.label}`
      case "effort": return `Effort for ${current.seat.label} on ${current.option.label}`
    }
  }
  /** The page the sheet body shows, so each keeps its own scroll position. */
  const place = () => {
    const current = page()
    return current.kind === "options" || current.kind === "effort" ? `${current.kind}:${current.seat.roleId}` : current.kind
  }
  const back = () => {
    navigation += 1
    const current = page()
    // Back from an effort re-reads the options: a save may have moved the
    // current mark since the list was fetched.
    if (current.kind === "effort" && isCurrent(current.owner)) openSeat(current.seat)
    else setPage({ kind: "roles" })
  }

  const seatGroups = (groups: Accessor<readonly SeatGroup[]>) => (
    <Key each={groups()} by={(group) => group.title}>
      {(group) => (
        <>
          <div class="sheet-section">{group().title}</div>
          <Key each={group().rows} by={(row) => row.roleId}>{(row) => <SheetRow label={row().label} detail={row().detail} value={row().value} working={client.actions.working(seatKey(row()))} onClick={() => openSeat(row())} />}</Key>
        </>
      )}
    </Key>
  )

  return (
    <Sheet title={title()} place={place()} onClose={client.closeSheet} tools={<Show when={page().kind !== "roles"}><button class="ghost-text" onClick={back}>Back</button></Show>}>
      <Show when={(seeded() && !table.loading) || visibleTable() !== undefined || page().kind !== "roles"} fallback={<SheetLoading />}>
        <Show when={table.error === undefined || visibleTable() !== undefined} fallback={<SheetEmpty>Could not read the roles: {describeFailure(table.error)}</SheetEmpty>}>
          <Show when={page().kind === "roles" ? visibleTable() : undefined}>
            {(current) => (
              <>
                <Show when={sessionId() !== undefined}>
                  <SheetRow
                    label={scope().kind === "session" ? "Scope: this session" : "Scope: every session"}
                    detail={scope().kind === "session" ? "Changes apply only to this conversation. Pick to edit the defaults instead." : "Changes are the defaults every session inherits. Pick to edit only this conversation."}
                    onClick={() => setScopeKind((kind) => (kind === "session" ? "defaults" : "session"))}
                  />
                </Show>
                {seatGroups(() => current().groups)}
                <div class="sheet-section">Accounts</div>
                <SheetRow label="Browse provider models…" detail="Turn individual models on or off for an exact account" onClick={() => client.openSheet("provider-models")} />
                <div class="sheet-section">Reset</div>
                <SheetRow label="Reset every role to its default…" tone="warn" working={client.actions.working(resetKey)} onClick={resetAll} />
              </>
            )}
          </Show>
          <Show when={optionsPage()}>
            {(current) => (
              <>
              <Show when={isProfileModelRole(current().seat.roleId)}><div class="sheet-section">Auth profile</div></Show>
              <Show when={current().seat.savedModel}>{(saved) => <div class="sheet-section">Saved: {saved()}</div>}</Show>
              <Key each={current().options} by={(option) => option.model}>
                {(option) => {
                  const detail = describeOption(option)
                  return (
                    <SheetRow
                      label={<>{option().current === true ? "✓ " : ""}{option().label}</>}
                      detail={detail}
                      tone={option().selectable ? undefined : "warn"}
                      working={client.actions.working(optionKey(current().seat, option()))}
                      disabled={!option().selectable}
                      onClick={() => choose(current(), current().seat, option())}
                    />
                  )
                }}
              </Key>
              </>
            )}
          </Show>
          <Show when={effortPage()}>
            {(current) => (
              <For each={current().efforts}>
                {(effort) => <SheetRow label={<>{effort.current === true ? "✓ " : ""}{effort.label}</>} working={client.actions.working(effortKey(current().seat, current().option, effort.effort))} onClick={() => { void save(current(), current().seat, current().option, effort.effort) }} />}
              </For>
            )}
          </Show>
        </Show>
      </Show>
    </Sheet>
  )
}
