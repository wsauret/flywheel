import { createComponent, createRoot } from "solid-js"

import type { SessionSummary } from "../client/view-state.js"
import { fakeClient, fakeClientActions, fakeClientHost, fakeViewState } from "./client-context-fixture.js"
import { createCommandPanel } from "./command-panel.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { useSessionActions } from "./session-actions.js"
import { SessionList } from "./session-list.js"

const session: SessionSummary = {
  id: "session-full-id",
  title: "Debug chat",
  kind: "chat",
  lifecycleState: "active",
  active: true,
  working: false,
  lastUpdated: "2026-09-20T12:00:00.000Z",
  totalsLoading: true,
}

const tick = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Mounts both shared session-copy entry points against one in-memory host. */
export function mountSessionCopyActions(currentSessionId: string | null = session.id) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const writes: string[] = []
    const selected: string[] = []
    const reports: { readonly severity: "info" | "warning"; readonly message: string }[] = []
    const state = fakeViewState({ sessionId: currentSessionId ?? undefined, sessions: [session] })
    const client = fakeClient({
      host: fakeClientHost({ capabilities: { writeClipboardText: async (text) => { writes.push(text) } } }),
      state: () => state,
      actions: fakeClientActions({
        newSession() {},
        closeSession() {},
        compact() {},
        selectSession: (selectedSessionId) => { selected.push(selectedSessionId) },
      }),
      report: (severity, message) => { reports.push({ severity, message }) },
    })
    Reflect.set(globalThis, "__flywheelSessionCopyTestClient", client)
    const actions = useSessionActions()
    insert(root, createComponent(SessionList, {
      sessions: [session],
      errors: [],
      selected: session.id,
      actions,
    }))
    const panel = createCommandPanel({
      client,
      query: () => "",
      close() {},
    })
    insert(root, panel.view)

    const find = (tag: string, label?: string) => {
      const found = nodes(root).find((node) => node.tag === tag && (label === undefined || node.properties["aria-label"] === label))
      if (found === undefined) throw new Error(`Missing ${tag}${label === undefined ? "" : ` ${label}`}`)
      return found
    }
    const command = () => nodes(root).find((node) => node.properties.class === "panel-row" && textContent(node).includes("Copy session ID"))
    const requiredCommand = () => {
      const found = command()
      if (found === undefined) throw new Error("Missing Copy session ID command")
      return found
    }
    const invoke = (node: ReturnType<typeof find>, property: string, event: unknown): void => {
      const handler = node.properties[property]
      if (typeof handler !== "function") throw new Error(`Missing ${property} handler`)
      handler(event)
    }

    return {
      dispose(): void {
        disposeRoot()
        Reflect.deleteProperty(globalThis, "__flywheelSessionCopyTestClient")
      },
      ready: tick,
      writes: () => writes,
      reports: () => reports,
      selected: () => selected,
      hasCurrentCommand: () => command() !== undefined,
      copyRow(): void {
        const button = find("button", "Copy session ID for Debug chat")
        let stopped = false
        invoke(button, "onClick", { stopPropagation() { stopped = true } })
        if (stopped) return
        for (let parent = button.parent; parent; parent = parent.parent) {
          const classes = typeof parent.properties.class === "string" ? parent.properties.class.split(" ") : []
          if (classes.includes("session-row")) {
            invoke(parent, "onClick", {})
            return
          }
        }
      },
      copyCurrent(): void {
        invoke(requiredCommand(), "onClick", {})
      },
    }
  })
}
