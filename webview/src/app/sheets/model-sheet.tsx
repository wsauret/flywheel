import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { CHAT_SLOT } from "../../client/active-model.js"
import { isProfileModelRole } from "../../../../src/protocol/brief-role-id.js"
import { summaryOf } from "../../client/view-state.js"

import type { EffortOptionRow, ModelAssignmentRow, ModelOptionRow, ModelTier } from "../../../../src/protocol/model-assignment-protocol-types.js"
import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"
import { useClient } from "../client-context.js"
import { createModelCatalogRevision } from "../model-catalog.js"
import { settingKeys, settingRowKey } from "../../client/settings-actions.js"
import { SettingRow, SheetSegment } from "./controls.js"
import { ModelOptionDetail } from "./model-option-detail.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "./sheet.js"

/** Model and effort: which model answers the transcript in view, a chat,
 *  a subagent, or a workflow agent, and how hard it tries (PI-INTERACTION-019).
 *
 *  Flywheel assigns models per role, and the full seat list lives behind a
 *  registry this client cannot load. This manages the one seat the protocol
 *  names on its own terms: scoped to the selected session when there is one,
 *  because the inline picker steers this conversation, and only the Models
 *  browser edits the defaults every new session inherits.
 *
 *  Effort travels with the model: the same seat at a different model may not
 *  offer the effort it currently holds, so the runtime is asked what is valid
 *  rather than the old value being carried over. */

const TIERS: readonly { readonly tier: ModelTier | undefined; readonly title: string }[] = [
  { tier: "default", title: "Default" },
  { tier: "powerful", title: "Powerful" },
  { tier: "mid", title: "Mid" },
  { tier: "cheap", title: "Cheap" },
  { tier: undefined, title: "Other" },
]

export function ModelSheet() {
  const client = useClient()
  const scope = () => {
    const sessionId = client.state().sessionId
    return sessionId === undefined ? { kind: "defaults" } as const : { kind: "session", sessionId } as const
  }
  // The seat the panel's rows read: the running agent's during a workflow,
  // otherwise the chat's, so the sheet edits what the composer's pill names.
  const slot = () => client.state().settings?.seatSlot ?? CHAT_SLOT
  // A child names its seat as an agent's whichever slot serves it: a general
  // subagent, or a persona child after a session Chat edit, serves from chat.
  const inView = () => summaryOf(client.state(), client.state().sessionId)
  const agentSession = () => inView()?.kind === "subagent" || inView()?.kind === "workflow-agent"
  /** The heading names the transcript the sheet edits, so a person sees which agent they steer. */
  const heading = () => {
    const title = inView()?.title
    return title === undefined ? "Model and effort" : `Model and effort: ${title}`
  }
  // The effort stops of the model in force, which the seat reading carries.
  const effortStops = () => (client.state().settings?.seatEfforts ?? []).flatMap((entry) => (entry.selectable && entry.effort !== null ? [{ value: entry.effort, label: entry.label, current: entry.current }] : []))
  const setEffort = (effort: string) => { void client.actions.applySetting({ kind: "set-effort", effort }) }
  const profileOwned = () => isProfileModelRole(slot().roleId)
  const owner = createMemo(() => ({ scope: scope(), slot: slot() }), undefined, {
    equals: (left, right) => left?.slot.roleId === right.slot.roleId && left?.scope.kind === right.scope.kind &&
      (left?.scope.kind !== "session" || (right.scope.kind === "session" && left.scope.sessionId === right.scope.sessionId)),
  })
  const revision = createModelCatalogRevision(() => owner().scope)
  const [seat] = createResource(() => {
    const currentRevision = revision()
    return currentRevision === undefined ? false : { owner: owner(), revision: currentRevision }
  }, async ({ owner: current }, previous): Promise<{
    owner: ReturnType<typeof owner>; assignment: ModelAssignmentRow | undefined; options: readonly ModelOptionRow[]
  }> => {
    try {
      const [assignments, options] = await Promise.all([
        client.connection.query({ type: "modelAssignments", scope: current.scope, slots: [current.slot] }),
        client.connection.query({ type: "modelOptions", scope: current.scope, slot: current.slot }),
      ])
      return { owner: current, assignment: assignments[0], options }
    } catch (cause) {
      if (previous.value?.owner === current) return previous.value
      throw cause
    }
  })
  const visible = () => seat.error === undefined && seat.latest?.owner === owner() ? seat.latest : undefined
  /** The model picked, while its effort is being chosen. */
  const [pending, setPending] = createSignal<{ readonly option: ModelOptionRow; readonly efforts: readonly EffortOptionRow[] } | undefined>(undefined)
  let generation = 0
  createEffect(on(owner, () => { generation += 1; setPending(undefined) }))
  onCleanup(() => { generation += 1 })

  const failed = (cause: unknown) => client.report("warning", `Flywheel did not change the model: ${describeFailure(cause)}`)

  // A row works from its tap until the runtime answers it: the model row
  // through the effort read and any save it starts, an effort row through
  // its save.
  const modelKey = (option: ModelOptionRow) => actionKey("model", option.model ?? "")
  const effortKey = (option: ModelOptionRow, effort: EffortOptionRow["effort"]) => actionKey("model-effort", `${option.model ?? ""}:${String(effort)}`)

  // Each read takes its generation when it starts, inside the action, so a
  // tap that joins a running read does not make that read stale. Saves to
  // one seat run in order, from this sheet or the Models sheet, so the last
  // tap lands last. A save writes the seat shown at its tap: a queued save
  // that runs after the workflow moved on still writes that seat.
  const save = (option: ModelOptionRow, effort: EffortOptionRow["effort"]): Promise<boolean> => {
    const target = { scope: scope(), slot: slot() }
    const seatName = inView()?.title ?? "Defaults"
    return client.actions.runInOrder(actionKey("model-seat", target.slot.roleId), effortKey(option, effort), () => {
      const read = ++generation
      return client.connection.dispatch({ type: "model.save_effort", ...target, model: option.model, effort })
        .then((result) => {
          if (read !== generation) return
          if (result.warning) client.report("warning", result.warning)
          else client.report("info", `${seatName}: ${result.label}`)
          client.closeSheet()
        })
        .catch(failed)
    })
  }

  const choose = (option: ModelOptionRow) => {
    if (!option.selectable) return
    void client.actions.run(modelKey(option), () => {
      const read = ++generation
      return client.connection.query({ type: "effortOptions", scope: scope(), slot: slot(), model: option.model })
        .then(async (efforts) => {
          if (read !== generation) return
          const selectable = efforts.filter((entry) => entry.selectable)
          if (selectable.length > 1) {
            setPending({ option, efforts: selectable })
            return
          }
          await save(option, selectable.find((entry) => entry.current)?.effort ?? selectable[0]?.effort ?? null)
        })
        .catch(failed)
    })
  }

  const grouped = () => {
    const options = visible()?.options ?? []
    return TIERS
      .map((group) => ({ ...group, options: options.filter((option) => (option.tier ?? undefined) === group.tier) }))
      .filter((group) => group.options.length > 0)
  }
  const describe = (option: Accessor<ModelOptionRow>) => (
    <ModelOptionDetail
      providers={option().providers}
      parts={[option().inheritModel !== undefined ? `inherits ${option().inheritModel}` : undefined, option().roleDefault === true ? "role default" : undefined, option().reason]}
    />
  )
  const cost = (option: ModelOptionRow) => (option.cost?.input === undefined ? undefined : `$${option.cost.input.toFixed(2)}/M in`)

  return (
    <Sheet
      title={pending() === undefined ? heading() : `Effort for ${pending()!.option.label}`}
      onClose={client.closeSheet}
      tools={<Show when={pending()}><button class="ghost-text" onClick={() => { generation += 1; setPending(undefined) }}>Back</button></Show>}
    >
      <Show when={(revision() !== undefined && !seat.loading) || visible() !== undefined} fallback={<SheetLoading />}>
        <Show when={seat.error === undefined || visible() !== undefined} fallback={<SheetEmpty>Could not read the chat seat: {describeFailure(seat.error)}</SheetEmpty>}>
          <Show
            when={pending()}
            fallback={
              <Show when={visible()?.assignment !== undefined} fallback={<SheetEmpty>No chat model seat is configured. Connect a provider first.</SheetEmpty>}>
                <div class="sheet-section">{profileOwned() ? "Auth profile" : scope().kind === "session" ? "This session" : "Defaults for new sessions"} · currently {visible()!.assignment!.model}</div>
                <Show when={effortStops().length > 1}>
                  <SettingRow label="Effort" detail={agentSession() ? "How hard this agent's model tries" : "How hard this chat's model tries"}>
                    <SheetSegment label="Effort" value={effortStops().find((entry) => entry.current)?.value ?? ""} options={effortStops()}
                      working={client.actions.working(settingRowKey("effort"))}
                      writing={(effort) => client.actions.working(settingKeys({ kind: "set-effort", effort }).write)}
                      onChange={setEffort} />
                  </SettingRow>
                </Show>
                <Show when={visible()?.assignment?.savedModel}>{(saved) => <div class="sheet-section">Saved: {saved()}</div>}</Show>
                <Show when={grouped().length > 0} fallback={<SheetEmpty>No models are available. Connect a provider first.</SheetEmpty>}>
                  <Key each={grouped()} by={(group) => group.title}>
                    {(group) => (
                      <>
                        <div class="sheet-section">{group().title}</div>
                        <Key each={group().options} by={(option) => option.model}>
                          {(option) => {
                            const detail = describe(option)
                            return (
                              <SheetRow
                                label={<>{option().current === true ? "✓ " : ""}{option().label}</>}
                                detail={detail}
                                value={cost(option())}
                                tone={option().reason === undefined ? undefined : "warn"}
                                working={client.actions.working(modelKey(option()))}
                                disabled={!option().selectable}
                                onClick={() => choose(option())}
                              />
                            )
                          }}
                        </Key>
                      </>
                    )}
                  </Key>
                </Show>
              </Show>
            }
          >
            {(chosen) => (
              <For each={chosen().efforts}>
                {(effort) => (
                  <SheetRow label={<>{effort.current === true ? "✓ " : ""}{effort.label}</>} working={client.actions.working(effortKey(chosen().option, effort.effort))} onClick={() => void save(chosen().option, effort.effort)} />
                )}
              </For>
            )}
          </Show>
        </Show>
      </Show>
    </Sheet>
  )
}
