import { createRoot } from "solid-js"
import { createAttachMenu } from "./attach-menu.js"
import { createElement, insert, nodes } from "./render-ownership-host-fixture.js"

/** Mounts the attachment menu with action observers and its real keyboard listener. */
export function mountAttachMenu() {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  type Key = { key: string; preventDefault(): void; stopPropagation(): void }
  const listeners = new Set<(event: Key) => void>()
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    addEventListener(type: string, listener: (event: Key) => void) { if (type === "keydown") listeners.add(listener) },
    removeEventListener(type: string, listener: (event: Key) => void) { if (type === "keydown") listeners.delete(listener) },
  } })
  return createRoot((dispose) => {
    const ran: string[] = []
    const menu = createAttachMenu({ rows: [
      { id: "files", label: "Add files", description: "Files", run: () => ran.push("files") },
      { id: "mention", label: "Mention", description: "Mention", run: () => ran.push("mention") },
    ] })
    const root = createElement("root")
    insert(root, menu.view())
    return {
      ran, open: menu.toggle, isOpen: menu.open,
      press(index: number, name: string) {
        const row = nodes(root).filter((node) => node.properties.role === "menuitem")[index]
        if (!row) throw new Error("Menu row missing")
        const handler = row.properties[name]
        if (typeof handler !== "function") throw new Error(`No ${name} handler`)
        let prevented = false
        handler({ preventDefault() { prevented = true } })
        return prevented
      },
      key(key: string) {
        let stopped = false
        const event = { key, preventDefault() {}, stopPropagation() { stopped = true } }
        for (const listener of listeners) listener(event)
        return stopped
      },
      dispose() {
        dispose()
        if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
        else Reflect.deleteProperty(globalThis, "document")
      },
    }
  })
}
