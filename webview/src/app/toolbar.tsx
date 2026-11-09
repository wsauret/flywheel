import { createMemo, Show, type Accessor } from "solid-js"

import type { BudgetSummary } from "../../../src/protocol/client/host-contract.js"
import { formatGenerationSpeed } from "../../../src/protocol/generation-statistics.js"
import type { WebModule } from "../web-module.js"
import { sessionLocationOf, summaryOf } from "../client/view-state.js"
import { actionKey } from "../client/action-key.js"
import { useClient } from "./client-context.js"
import { describeFailure } from "../client/failure-message.js"
import { Icon, ICONS } from "./icons.js"
import { ToolbarBadges } from "./toolbar-badges.js"
import { ComposerStatus } from "./composer-status.js"
import { ContextGauge } from "./context-gauge.js"
import { describeUpdateStatus } from "../../../src/protocol/client/update-status-copy.js"
import type { UpdateStatus } from "../../../src/protocol/update-protocol-types.js"

/** The update states the toolbar chip shows: a release a person can take or
 *  restart into, whose remedy is opening Status. A release that could not
 *  start on this machine asks nothing of the person, so only the Status rows
 *  name it (PI-UPDATES-008). */
const CHIP_UPDATE_KINDS: ReadonlySet<UpdateStatus["kind"]> = new Set(["available", "installing", "installed"])

/** The header row: which chat this is, and the readings a person glances at
 *  while a turn runs. Everything else lives in the command panel, so this row
 *  carries only what a glance needs: the session, the cost, generation speed,
 *  what needs attention, and whether the runtime is reachable. */
/** `wide` says the rail is beside the pane, so the title is a plain title;
 *  otherwise the title is the way to the session list. `rail` is present
 *  whenever the pane is wide enough to have a rail at all, folded or not, so
 *  the toolbar can offer the fold and the unfold in the same spot. `modules`
 *  is the registry whose badges follow the kernel's own controls. */
export function Toolbar(props: { readonly wide: boolean; readonly rail?: { readonly collapsed: boolean; readonly toggle: () => void } | undefined; readonly modules: readonly WebModule[] }) {
  const client = useClient()
  const state = client.state
  const current = () => summaryOf(state(), state().sessionId)
  const location = createMemo(() => sessionLocationOf(state(), client.stack?.placement()?.project))
  const locationLine = () => (
    <>
      <Show when={location().project}>{(project) => <span class="toolbar-location-name">{project()}</span>}</Show>
      <Show when={location().worktree}>{(worktree) => <><Show when={location().project}><span aria-hidden="true"> · </span></Show><span class="toolbar-location-name">{worktree()}</span></>}</Show>
      <Show when={location().branch}>{(branch) => <><Show when={location().project || location().worktree}><span aria-hidden="true"> · </span></Show><span class="toolbar-location-branch"><Icon path={ICONS.branch} /><span class="visually-hidden">branch </span> {branch()}</span></>}</Show>
    </>
  )
  // A child still opening knows its parent from the tap, so Back shows at once.
  const parent = () => summaryOf(state(), state().parentSessionId)
  // A destination still opening is named by what the person tapped, or
  // "New chat", so the title moves with the tap.
  const title = () => state().destinationName ?? (state().sessions.length === 0 ? "Flywheel" : "Select a chat")
  // Close, Delete, and Rename of the open chat often start from the command
  // panel, which closes at once, so the chat's own title shows that they work.
  const acting = () => {
    const sessionId = state().sessionId
    return (sessionId !== undefined && client.actions.sessionWorking(sessionId)) || undefined
  }
  // The same three states the session rows show, for the chat in view.
  const dot = () => <span class="session-dot" classList={{ open: current()?.active === true, live: current()?.working === true, waiting: current()?.awaitingAnswer === true }} />
  const heading = () => (
    <span class="toolbar-title-text">
      {title()}
    </span>
  )
  const updateChip = () => {
    const status = state().update?.status
    return status !== undefined && CHIP_UPDATE_KINDS.has(status.kind) ? describeUpdateStatus(status) : undefined
  }
  return (
    <header class="toolbar toolbar-chat">
      <Show when={!client.stack ? (parent() === undefined ? undefined : { label: parent()!.title, onPress: () => client.actions.selectSession(parent()!.id) }) : undefined}>
        {(back) => (
          <button
            class="ghost toolbar-back"
            title={`Back to ${back().label}`}
            aria-label={`Back to ${back().label}`}
            onClick={() => back().onPress()}
          >
            <Icon path={ICONS.chevronLeft} size={18} />
          </button>
        )}
      </Show>
      <Show when={props.rail}>
        {(rail) => (
          <button
            class="ghost toolbar-rail"
            title={rail().collapsed ? "Show the session list (Mod+B)" : "Hide the session list (Mod+B)"}
            aria-label={rail().collapsed ? "Show the session list" : "Hide the session list"}
            aria-pressed={!rail().collapsed}
            onClick={() => rail().toggle()}
          >
            <Icon path={ICONS.sidebar} />
          </button>
        )}
      </Show>
      <Show
        when={!props.wide}
        fallback={
          <span class="toolbar-title" aria-busy={acting()}>
            {dot()}
            {heading()}
            <span class="toolbar-location" title={location().directory}>{locationLine()}</span>
          </span>
        }
      >
        <Show
          when={client.stack}
          fallback={
            <>
              {/* On a narrow container the header is the way to the session list.
                  The trigger reads as the title, so the list is where the title is. */}
              <button class="toolbar-sessions" aria-haspopup="dialog" onClick={() => client.openSheet("sessions")}>
                {dot()}
                <span class="toolbar-title" aria-busy={acting()}>{heading()}</span>
                <span class="toolbar-location" title={location().directory}>{locationLine()}</span>
                <Show when={state().sessions.some((session) => session.awaitingAnswer && session.id !== state().sessionId)}>
                  <span class="toolbar-needs" title="Another chat is waiting on your answer" aria-label="Another chat needs you"><span>needs you</span></span>
                </Show>
                <Icon path={ICONS.chevronDown} />
              </button>
              {/* New chat sits beside the picker on purpose: choosing a session and
                  starting one are the same decision, so they share a spot. */}
              <button class="ghost" title="New chat" aria-label="New chat" aria-busy={client.actions.working(actionKey("new-chat")) || undefined} onClick={() => client.actions.newSession()}>
                <Icon path={ICONS.plus} />
              </button>
            </>
          }
        >
          {(stack) => (
            <>
              {/* An agent view's entry sits over its workflow's, so the
                  history's back returns to where the agent opened from. */}
              <button
                class="ghost toolbar-back"
                title={state().parentSessionId === undefined ? "Sessions" : parent() === undefined ? "Open parent session" : `Open parent: ${parent()?.title}`}
                aria-label={state().parentSessionId === undefined ? "Back to sessions" : parent() === undefined ? "Open parent session" : `Open parent session ${parent()?.title}`}
                onClick={() => stack().back()}
              >
                <Icon path={ICONS.chevronLeft} size={18} />
              </button>
              <span class="toolbar-heading">
                <span class="toolbar-title" aria-busy={acting()}>
                  {dot()}
                  {heading()}
                </span>
                <span class="toolbar-subtitle" title={location().directory}>{locationLine()}</span>
              </span>
              <Show when={state().sessions.some((session) => session.awaitingAnswer && session.id !== state().sessionId)}>
                <span class="toolbar-needs" title="Another chat is waiting on your answer" aria-label="Another chat needs you"><span>needs you</span></span>
              </Show>
            </>
          )}
        </Show>
      </Show>

      <span class="toolbar-spacer" />

      <Show when={state().budget}>
        {(budget) => <>
          <ToolbarBudgetReadings budget={budget} />
          <ContextGauge budget={budget} compact={() => client.actions.compact()} compacting={client.actions.working(actionKey("compact", state().sessionId))} />
        </>}
      </Show>

      {/* An update the runtime has fetched but not yet running, the way the
          TUI's composer border shows it. Opening Status says what to do. */}
      <Show when={updateChip()}>{(chip) => <button class="connection connection-update" title="A Flywheel update is ready. Open Status for details." onClick={() => client.openSheet("status")}>{chip()}</button>}</Show>
      <ComposerStatus />
      <ToolbarBadges modules={props.modules} report={(module, error) => client.report("warning", `The ${module.id} module could not count its badge: ${describeFailure(error)}`)} />
    </header>
  )
}

function ToolbarBudgetReadings(props: {
  readonly budget: Accessor<BudgetSummary>
}) {
  const ready = () => readyBudget(props.budget())
  return (
    <>
      <Show when={ready()} fallback={<span class="cost-pill" aria-busy={true}>totals loading</span>}>
        {(budget) => (
          <span
            class="cost-pill"
            title={
              budget().priceUnavailable
                ? `$${budget().cost.toFixed(2)} known model cost this session; pricing is unavailable for some usage, so the total is incomplete`
                : budget().billedCost > 0
                  ? `$${budget().billedCost.toFixed(2)} billed to your API keys this session${budget().cost - budget().billedCost > 0.005 ? `, plus ~$${(budget().cost - budget().billedCost).toFixed(2)} covered by your subscription` : ""}`
                  : `~$${budget().cost.toFixed(2)} of model value this session, covered by your subscription`
            }
          >
            {budget().priceUnavailable
              ? "price unavailable"
              : budget().cost === 0
                ? "no usage"
                : budget().billedCost > 0 ? `$${budget().billedCost.toFixed(2)}` : `~$${budget().cost.toFixed(2)}`}
          </span>
        )}
      </Show>
      <Show when={formatGenerationSpeed(ready()?.averageGenerationTokensPerSecond)}>
        {(speed) => <span class="generation-speed" title="This agent's average generation speed in local comparison tokens. Open Stats for coverage.">{speed()}</span>}
      </Show>
    </>
  )
}

function readyBudget(budget: BudgetSummary): Extract<BudgetSummary, { readonly totalsLoading: false }> | undefined {
  return budget.totalsLoading ? undefined : budget
}
