import { createRoot, createSignal } from "solid-js"
import { mountSemanticComponent, type SemanticPublication } from "../../app/semantic-rows-fixture.js"
import type { FakeConnectionScript } from "../../client/runtime-connection-fixture.js"
import type { RemoteHostCapability, RemoteHostSnapshot } from "../../host.js"
import { RemoteSheet } from "./sheet.js"
import { RuntimesSheet } from "./runtimes.js"

/** A device that has paired with no machine yet. */
const UNPAIRED: RemoteHostSnapshot = { deviceLabel: "Phone", selected: undefined, pairing: { status: "idle" }, runtimes: [] }

/** Mounts remote surfaces with immutable client and host publications. */
export function mountSemanticRows(kind: "remote" | "machines", initial: SemanticPublication, options: { snapshot?: RemoteHostSnapshot; setLabel?: (label: string) => Promise<void>; connection?: FakeConnectionScript } = {}) {
  return createRoot(dispose => {
    const [snapshot, setSnapshot] = createSignal(options.snapshot ?? UNPAIRED)
    const listeners = new Set<(value: RemoteHostSnapshot) => void>()
    const remote: RemoteHostCapability = {
      deviceId: "phone",
      snapshot,
      onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
      select: (target) => { mounted.calls().push(target) },
      forget: async (id) => { mounted.calls().push(id) },
      setLabel: async (label) => { mounted.calls().push(label); await options.setLabel?.(label) },
      pair: async () => { throw new Error("The fixture pairs no machine") },
      createProject: async () => { throw new Error("The fixture creates no project") },
    }
    const mounted = mountSemanticComponent(kind === "remote" ? RemoteSheet : RuntimesSheet, initial, options.connection, { remote })
    return {
      ...mounted,
      dispose() { mounted.dispose(); dispose() },
      publishSnapshot(next: RemoteHostSnapshot) { setSnapshot(next); for (const listener of listeners) listener(next) },
    }
  })
}
