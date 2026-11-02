import { createMemo, createSignal, Show, useContext } from "solid-js"
import { agentGroupClockRuns, agentGroupInFlight, agentGroupInitializing, agentGroupModelLabel } from "../../../src/protocol/client/agent-group-summary.js"
import { childCardStatus, dispatchInterrupt, resumeMutation, subagentCardControls } from "../../../src/protocol/client/session-controls.js"
import { subagentHeaderParts, subagentLine } from "../../../src/protocol/client/subagent-line.js"
import { parseSessionLink } from "../../../src/protocol/client/session-links.js"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { blockEndTimes } from "../client/tool-runs.js"
import { RowTime, TranscriptClock } from "./row-time.js"
import { createSessionReading, type SessionReadingSource } from "./session-reading.js"
import { TranscriptRows } from "./transcript-rows.js"
import { AgentLineCells } from "./agent-line.js"
import { SubagentHeader } from "./subagent-header.js"
import { ClientContext } from "./client-context.js"
import { actionKey, controlActionKey } from "../client/action-key.js"
import { CARD_ACTION_COPY, CardActionHeader, type CardAction } from "./card-action-header.js"
import "../styles/workflow-card.css"

type AgentGroupBlock = Extract<FrontendOutputBlock, { kind: "agentGroup" }>

/** Ordinary delegated activity opens its real child session. Modules render their own activity. */
export function AgentGroup(props: {
  block: AgentGroupBlock
  children?: { readonly children: readonly FrontendToolEntry[]; readonly total: number } | undefined
  onSelectSession: (sessionId: string, label: string) => void
  onTerminateBackground: (toolUseId: string) => void
  working: (key: string) => boolean
  onHydrateGroup: (groupBlockId: string) => void
  roleAssignments: SessionReadingSource<RoleAssignmentView>
  statuses: SessionReadingSource<StatusView>
  sessionId: string
  onOpenFile?: ((path: string) => void) | undefined
}) {
  const [open, setOpen] = createSignal(false)
  const count = () => props.block.totalToolCount
  const loaded = () => props.children ?? (props.block.children.length === count() ? { children: props.block.children, total: count() } : undefined)
  const active = () => agentGroupInFlight(props.block)
  const client = useContext(ClientContext)
  const clock = useContext(TranscriptClock)
  const now = () => agentGroupClockRuns(props.block) ? clock?.now() ?? Date.now() : 0
  const linkedSession = createMemo(() => parseSessionLink(props.block.linkUri)?.sessionId)
  const roles = createSessionReading(linkedSession, props.roleAssignments)
  const status = createSessionReading(() => active() ? linkedSession() : undefined, props.statuses)
  const child = createMemo(() => childCardStatus(status(), props.sessionId))
  const summaryBlock = () => ({ ...props.block, model: agentGroupModelLabel(props.block.model, roles()) })
  const initializing = () => agentGroupInitializing(summaryBlock())
  const line = createMemo(() => subagentLine(props.block, child(), now()))
  const parts = () => initializing()
    ? subagentHeaderParts(summaryBlock()).filter(part => part.kind === "persona" || part.kind === "goal")
    : subagentHeaderParts(props.block, summaryBlock().model)
  const heldSession = createMemo(() => props.block.status === "completed" ? undefined : linkedSession())
  const row = createSessionReading(heldSession, {
    get: id => client?.sessionDetails?.get(id),
    subscribe: (id, listener) => client?.sessionDetails?.subscribe(id, listener) ?? (() => {}),
  })
  const controls = () => subagentCardControls(row(), active())
  const control = (kind: "interrupt" | "resume") => {
    const target = row()
    if (client === undefined || target === undefined) return
    void client.actions.run(controlActionKey(kind, target.id), async () => {
      if (kind === "interrupt") {
        const refusal = await dispatchInterrupt(client.connection, target)
        if (refusal) throw new Error(refusal.reason)
      } else {
        const result = await client.connection.dispatch(resumeMutation(target))
        if (!result.ok) throw new Error(result.error)
      }
    })
  }
  const actions = (): readonly CardAction[] => {
    if (initializing()) return []
    const admitted = controls()
    const result: CardAction[] = []
    if (admitted.primary) {
      const kind = admitted.primary
      result.push({ kind, ...CARD_ACTION_COPY[kind],
        title: kind === "interrupt" ? "Interrupt this subagent. Resume continues it." : "Continue this subagent with no new message.",
        busyKey: controlActionKey(kind, linkedSession() ?? ""), run: () => control(kind) })
    }
    if (admitted.stop) result.push({ kind: "stop", ...CARD_ACTION_COPY.stop, title: "Stop this subagent.",
      busyKey: actionKey("stop-tool", props.block.toolUseId), run: () => props.onTerminateBackground(props.block.toolUseId) })
    return result
  }
  const expandable = () => !initializing() && (linkedSession() !== undefined || (!active() && count() > 0))
  const select = () => { const id = linkedSession(); if (id !== undefined) props.onSelectSession(id, props.block.label) }
  const ends = createMemo(() => blockEndTimes(loaded()?.children ?? []))
  return <div class="block agent-group-block chain">
    <RowTime timestamp={props.block.timestamp} duration={line().time || undefined} always={active()} />
    <CardActionHeader class="subagent-head" actions={actions()} working={props.working}>
      <button class="disclosure" classList={{ static: !expandable() }}
        title={!initializing() && linkedSession() !== undefined ? "Open this run's own session" : undefined}
        data-expansion-pending={loaded() === undefined || undefined}
        aria-expanded={linkedSession() !== undefined || !expandable() ? undefined : open()}
        onClick={() => {
          if (initializing()) return
          if (linkedSession() !== undefined) { select(); return }
          if (!expandable()) return
          setOpen(value => !value)
          if (open() && loaded() === undefined) props.onHydrateGroup(props.block.id)
        }}>
        <span class="chevron">{active() ? <span class="marker-dot live" /> : linkedSession() !== undefined ? <span class="marker-dot" /> : open() ? "▾" : count() === 0 ? <span class="marker-dot" /> : "▸"}</span>
        <SubagentHeader parts={parts()} />
        <Show when={!initializing() && linkedSession() !== undefined}><span class="agent-open">{"\u2197 Open"}</span></Show>
      </button>
    </CardActionHeader>
    <div class={`subagent-line workflow-card-agent last state-${line().state} tone-${line().tone}`}>
      <AgentLineCells glyph={line().glyph} detail={line().detail} tone={line().tone} />
    </div>
    <Show when={line().failureDetail}>{detail => <div class="subagent-line subagent-failure"><span class="subagent-line-detail">{detail()}</span></div>}</Show>
    <Show when={open() && !active()}><div class="group-body">
      <Show when={loaded()} fallback={<div class="group-loading">Loading what this agent did…</div>}>{group => <>
        <TranscriptRows blocks={group().children} showThinking={false} compact onOpenFile={props.onOpenFile} endOf={id => ends().get(id)} />
        <Show when={group().children.length < group().total}><div class="group-loading">{group().total - group().children.length} more not shown</div></Show>
      </>}</Show>
    </div></Show>
  </div>
}
