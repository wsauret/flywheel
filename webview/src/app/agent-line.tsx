import { Show, type JSX } from "solid-js"
import type { WorkflowAgentDetail } from "../../../src/protocol/client/workflow-card.js"
import "../styles/agent-line.css"

/** The cells shared by workflow agents and delegated agents. The caller owns
 *  the row, its grid, navigation, and any full-size workflow figures. */
export function AgentLineCells(props: {
  readonly glyph: string
  readonly label?: string
  readonly detail: WorkflowAgentDetail | undefined
  readonly time?: string
  readonly full?: boolean
  readonly beforeDetail?: JSX.Element
  /** Leads the detail cell's text, which ellipsizes after it. */
  readonly detailLead?: JSX.Element
  readonly afterDetail?: JSX.Element
  readonly tone?: "running" | "done" | "warning" | "failed" | "muted"
}) {
  const identity = () => <><span class="workflow-card-branch" /><span class="workflow-card-glyph">{props.glyph}</span><Show when={props.label !== undefined}><span class="workflow-card-label">{props.label}</span></Show></>
  return <>
    <Show when={!props.full} fallback={identity()}><span class="workflow-card-head">{identity()}</span></Show>
    {props.beforeDetail}
    <span class="workflow-card-detail" classList={{
      "tone-failed": props.tone === undefined ? props.detail?.kind === "reason" : props.tone === "failed",
      "tone-warning": props.tone === "warning",
    }}>
      {props.detailLead}<span class="workflow-card-tool">{props.detail?.kind === "activity" ? props.detail.tool : ""}</span>{props.detail?.kind === "activity" ? " " : ""}{props.detail?.text ?? ""}
    </span>
    {props.afterDetail}
    <Show when={props.time !== undefined}><span class="workflow-card-time">{props.time}</span></Show>
  </>
}
