import { Key } from "@solid-primitives/keyed"
import { type Accessor, createMemo, type JSX, Match, on, Show, Switch } from "solid-js"

import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { foldReadRuns, type ReadRun, type RunRow } from "../../../src/protocol/client/tool-run-category.js"
import { toolActivity, toolProcess } from "../../../src/protocol/client/transcript-model.js"
import { rowIdentity, toolGroupKeys, toolGroupSummaryParts, type ToolGroup, type PresentedWebBlock } from "../client/tool-runs.js"
import type { BlockProps, createToolPresentation } from "./blocks.js"
import { CompactToolRow } from "./compact-tool-row.js"
import { Icon, ICONS } from "./icons.js"
import type { BlockDisclosure } from "./block-disclosure.js"
import { RowTime } from "./row-time.js"

/** A stretch of tool calls under one counting heading.
 *
 *  A settled stretch of one call is that call's own row. Growing stretches preview
 *  their newest four calls. From the second call on, the stretch collapses under
 *  a heading that says what was run and used, and the heading changes in
 *  place as calls land, because the group keys on its first member. Opening
 *  it shows every call as its own row, reads compact and merged by name, the
 *  rest with their own disclosure. The marker pulses while any call runs. */
export function ToolGroupBlock(props: {
  group: ToolGroup
  /** The resident tail can receive more calls before the turn settles. */
  tailCanGrow: boolean
  sessionId: string
  disclosure: BlockDisclosure
  processStatus?: BlockProps["processStatus"]
  row: (child: Accessor<PresentedWebBlock>, inlineTime?: boolean) => JSX.Element
  presentation: (entry: Accessor<FrontendToolEntry>, key: Accessor<string>) => ReturnType<typeof createToolPresentation>
  /** Opens a file a compact read row names; absent where the host opens no files. */
  onOpenFile?: ((path: string) => void) | undefined
}) {
  // The key a group renders under changes when a window keys its stretch
  // afresh, so the person's choice is found under any key the group answers to.
  const choiceKey = createMemo(() => props.disclosure.chosenKey(props.sessionId, toolGroupKeys(props.group)) ?? props.group.id)
  const open = () => props.disclosure.state(props.sessionId, choiceKey())().open
  const tally = createMemo(() => toolGroupSummaryParts(props.group.children))
  const oneCall = () => props.group.children.length === 1 && props.group.members.length === 1
  const single = () => !previewing() && oneCall()
  const active = createMemo(() => props.group.status === "active" || props.group.children.some((entry) => toolActivity(entry, toolProcess(props.processStatus, entry.id)).active))
  const previewing = createMemo(() => active() || (props.tailCanGrow && props.group.endTimestamp === undefined))
  const hasCall = createMemo(() => props.group.children.length > 0)
  const tool = createMemo(on(hasCall, present => {
    if (!present) return undefined
    return props.presentation(() => {
      // SAFETY: this reactive owner exists only while the stretch has a call.
      return props.group.children[0]!
    }, choiceKey)
  }))
  const timestamp = createMemo(() => props.group.timestamp)
  const end = createMemo(() => props.group.endTimestamp)
  // Reads fold by name; a thought or any other call keeps its place between
  // them, so the body is the stretch in order with only the reads merged.
  const rows = (): readonly (ReadRun | PresentedWebBlock)[] => {
    const out: (ReadRun | PresentedWebBlock)[] = []
    let calls: (FrontendToolEntry & PresentedWebBlock)[] = []
    const drain = () => { out.push(...foldReadRuns(calls)); calls = [] }
    for (const member of props.group.members) {
      if (member.kind === "tool") calls.push(member)
      else { drain(); out.push(member) }
    }
    drain()
    return out
  }
  return (
      <div class="block chain" data-tool-stretch={props.group.id} classList={{ open: open(), "tool-group": !single(), tool: single(), "timed-block": single(), [`status-${props.group.children[0]?.status}`]: single(), "execute-summary": single() && props.group.children[0]?.runCategoryOverride === "execute" }}>
        <RowTime timestamp={timestamp()} end={end()} running={active()} always={active()} />
        <div class="tool-head">
        <button class={single() ? "disclosure" : "disclosure tool-group-head"}
          classList={{ static: single() && (tool()?.static() ?? false) }}
          aria-expanded={single() ? tool()?.expanded() : open()}
          title={single() ? tool()?.hint() : undefined}
          onClick={() => {
            if (single()) tool()?.activate()
            else props.disclosure.setOpen(props.sessionId, choiceKey(), !open())
          }}>
        <Show when={single()} fallback={<>
          <span class="chevron">{active() ? <span class="marker-dot live" /> : open() ? "▾" : "▸"}</span>
          <span class="tool-group-summary">
            <Icon path={tally().commands >= tally().tools ? ICONS.terminal : ICONS.list} />
            <span>{tally().heading}</span>
            <Show when={tally().failed || tally().interrupted}>
              {" "}
              <span>(<Show when={tally().failed > 0}><span class="tool-group-failed">{tally().failed} failed</span></Show>
                {tally().failed && tally().interrupted ? ", " : ""}
                <Show when={tally().interrupted > 0}>{tally().interrupted} interrupted</Show>)</span>
            </Show>
          </span>
        </>}>
          {tool()?.marker}{tool()?.label}
        </Show>
        </button>
        <Show when={oneCall()}>{tool()?.actions}</Show>
        </div>
          <div classList={{ "group-body": !oneCall() }}>
            <Key each={rows()} by={rowIdentity}>
              {(row) => {
                const firstCall = () => {
                  const first = props.group.children[0]
                  return first !== undefined && rowIdentity(row()) === blockIdentity(first)
                }
                const compact = () => {
                  const current = row()
                  return current.kind === "readRun" || (current.kind === "tool" && current.action === "file_read")
                }
                const compactRow = (): RunRow | undefined => {
                  const current = row()
                  return current.kind === "readRun" || current.kind === "tool" ? current : undefined
                }
                const block = (): PresentedWebBlock | undefined => {
                  const current = row()
                  return current.kind === "readRun" ? undefined : current
                }
                return (
                  <Show when={firstCall()} fallback={<Show when={open() && !oneCall()}><Switch>
                    <Match when={compact() ? compactRow() : undefined}>{(settled) => <CompactToolRow row={settled()} onOpenFile={props.onOpenFile} />}</Match>
                    <Match when={block()}>{(settled) => props.row(settled, true)}</Match>
                  </Switch></Show>}>
                    <Show when={open() && !oneCall()}>
                      <div class="tool-head">
                        <Show when={compact() ? compactRow() : undefined} fallback={
                          <button class="disclosure" classList={{ static: tool()?.static() ?? false }}
                            aria-expanded={tool()?.expanded()} title={tool()?.hint()} onClick={() => tool()?.activate()}>
                            {tool()?.marker}{tool()?.label}
                            <Show when={block()}>{entry => <RowTime timestamp={entry().timestamp} id={rowIdentity(entry())} inline />}</Show>
                          </button>
                        }>{entry => <CompactToolRow row={entry()} onOpenFile={props.onOpenFile} />}</Show>
                        {tool()?.actions}
                      </div>
                    </Show>
                    <Show when={oneCall() || (open() && !compact())}>{tool()?.notices}</Show>
                    {tool()?.body}
                  </Show>
                )
              }}
            </Key>
          </div>
        <Show when={!open() && previewing()}>
          <div class="group-body live-preview">
            <Key each={props.group.members.filter(member => member.kind !== "thinking").slice(-4)} by={rowIdentity}>
              {child => {
                const call = (): FrontendToolEntry | undefined => {
                  const current = child()
                  return current.kind === "tool" ? current : undefined
                }
                return <Show when={call()} fallback={props.row(child, true)}>
                  {entry => <CompactToolRow row={entry()} onOpenFile={props.onOpenFile} inPreview hideTime />}
                </Show>
              }}
            </Key>
          </div>
        </Show>
      </div>
  )
}
