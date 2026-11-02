import { createRoot } from "solid-js"
import { fakeClient, fakeClientActions, fakeViewState } from "./client-context-fixture.js"
import type { ProjectFileEntry } from "../../../src/protocol/transcript-protocol-types.js"
import { FindBar } from "./find-bar.js"
import { createMentionPanel } from "./mention-panel.js"
import { createElement, insert, nodes } from "./render-ownership-host-fixture.js"

/** Mounts the real find and mention pickers with deterministic search responses. */
export function mountOptionPickers() {
  const opened: string[] = []
  const picked: ProjectFileEntry[] = []
  const pages: number[] = []
  const entry = { path: "src/app.ts", directory: false }
  const view = fakeViewState({ sessionId: "chat" })
  const client = fakeClient({
    state: () => view,
    actions: fakeClientActions({
      projectFiles: async () => [entry],
      searchTranscripts: async ({ page }) => {
        pages.push(page)
        return { total: 2, page, pageSize: 1, hits: [{ sessionId: "chat", entryId: `entry-${page}`, role: "assistant", snippet: "match" }] }
      },
      openAround: async (_sessionId, entryId) => { opened.push(entryId); return "block" },
    }),
  })
  Reflect.set(globalThis, "__flywheelOptionPickerClient", client)
  return createRoot(dispose => {
    const root = createElement("root")
    root.properties.class = "pane-resident"
    const mention = createMentionPanel({ client, token: () => ({ query: "app", start: 0, end: 4 }), pick: value => picked.push(value) })
    insert(root, mention.view)
    insert(root, () => <FindBar query="" onClose={() => {}} />)
    const input = nodes(root).find(node => node.tag === "input")!
    const invoke = (node: ReturnType<typeof nodes>[number], kind: string, event: { readonly currentTarget: { readonly value: string } } | { preventDefault(): void }) => {
      const handler = node.properties[kind]
      if (typeof handler !== "function") throw new Error(`No ${kind} handler`)
      handler(event)
    }
    return {
      opened, picked, pages,
      query() { invoke(input, "onInput", { currentTarget: { value: "match" } }) },
      press(surface: "find" | "mention" | "more", kind: "onPointerDown" | "onMouseDown" | "onClick") {
        const node = nodes(root).find(candidate => surface === "mention" ? candidate.properties.role === "option" && candidate.tag === "div"
          : surface === "find" ? candidate.properties.role === "option" && candidate.tag === "li"
            : candidate.tag === "button" && candidate.properties.class === "ghost-text" && candidate.parent?.properties.class === "find-more")
        if (!node) throw new Error(`No ${surface} control`)
        let prevented = false
        invoke(node, kind, { preventDefault() { prevented = true } })
        return prevented
      },
      dispose() { dispose(); Reflect.deleteProperty(globalThis, "__flywheelOptionPickerClient") },
    }
  })
}
