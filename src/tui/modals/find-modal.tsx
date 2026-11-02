/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createSignal, For, Show } from "solid-js"
import type { SessionCatalogRow } from "../../protocol/app-service-types.js"
import type { TranscriptSearchHit } from "../../protocol/transcript-protocol-types.js"
import { ModalFooter } from "../components/modal-footer.js"
import { ModalFrame } from "../components/modal-frame.js"
import { useModalDimensions } from "../hooks/use-modal-dimensions.js"
import { useTheme } from "../context/theme.js"
import type { FindScope } from "../hooks/use-find-modal.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface FindModalProps {
  query: string
  scope: FindScope
  hits: readonly TranscriptSearchHit[]
  total: number
  busy: boolean
  cursor: number
  hitSession: (hit: TranscriptSearchHit) => SessionCatalogRow | undefined
  onClose: () => void
  onRowClick: (rowIndex: number) => void
  onOpen: (rowIndex: number) => void
}

const ROLE_LABELS = { user: "You", assistant: "Flywheel", tool: "Tool", summary: "Summary" } satisfies { [Role in TranscriptSearchHit["role"]]: string }

/** A snippet's bracketed matches, as the index marks them, split for emphasis. */
function snippetParts(snippet: string): Array<{ readonly text: string; readonly match: boolean }> {
  return snippet.split(/(\[[^\]]*\])/).filter((part) => part.length > 0).map((part) =>
    part.startsWith("[") && part.endsWith("]") ? { text: part.slice(1, -1), match: true } : { text: part, match: false })
}

export function FindModal(props: FindModalProps) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(96, 12, 20)
  const [scrollbox, setScrollbox] = createSignal<ScrollBoxRenderable | undefined>()
  createEffect(() => {
    const viewport = scrollbox()
    const maxHeight = listMaxHeight()
    if (!viewport || maxHeight <= 0) return
    const rowTop = props.cursor * 2
    if (rowTop < viewport.scrollTop) viewport.scrollTo(rowTop)
    else if (rowTop + 2 > viewport.scrollTop + maxHeight) viewport.scrollTo(Math.max(0, rowTop - maxHeight + 2))
  })
  const summary = () => {
    if (props.query.trim().length === 0) return "Type to search"
    if (props.busy && props.hits.length === 0) return "Searching…"
    if (props.total === 0) return "No matches"
    return `${props.cursor + 1} of ${props.total}`
  }
  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.find} width={modalWidth()} onClose={props.onClose}>
      <box height={1} />
      <box flexDirection="row" paddingLeft={2} paddingRight={2}>
        <text fg={theme.textMuted}>{"› "}</text>
        <text fg={theme.text}>{props.query}</text>
        <text fg={theme.accent}>{"▏"}</text>
      </box>
      <box flexDirection="row" paddingLeft={2} paddingRight={2} gap={2}>
        <text fg={theme.textMuted}>
          <span style={{ fg: props.scope === "session" ? theme.text : theme.textMuted }}>{"This chat"}</span>
          <span>{"  ·  "}</span>
          <span style={{ fg: props.scope === "project" ? theme.text : theme.textMuted }}>{"All chats"}</span>
        </text>
        <text fg={theme.textMuted}>{summary()}</text>
      </box>
      <box height={1} />
      <Show when={props.hits.length > 0}>
        <scrollbox ref={(element: ScrollBoxRenderable) => setScrollbox(element)} height={Math.min(props.hits.length * 2, listMaxHeight())} maxHeight={listMaxHeight()} scrollbarOptions={{ visible: false }}>
          <For each={props.hits}>
            {(hit, index) => (
              <box flexDirection="column" height={2} paddingLeft={1} paddingRight={1} backgroundColor={props.cursor === index() ? theme.backgroundElement : undefined} onMouseDown={() => props.onRowClick(index())}>
                <text overflow="hidden" wrapMode="none">
                  <span style={{ fg: theme.textMuted }}>{`${ROLE_LABELS[hit.role].padEnd(9)}`}</span>
                  <For each={snippetParts(hit.snippet)}>{(part) => <span style={{ fg: part.match ? theme.accent : theme.text }}>{part.text}</span>}</For>
                </text>
                <text fg={theme.textMuted} overflow="hidden" wrapMode="none">{`         ${props.scope === "project" ? (hit.sessionTitle ?? props.hitSession(hit)?.title ?? hit.sessionId) : ""}`}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <box paddingTop={1}><ModalFooter rows={["type to search · tab scope · ↑↓ navigate · enter open · esc close"]} /></box>
    </ModalFrame>
  )
}
