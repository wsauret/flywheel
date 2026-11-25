/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/modules/module-domain.js"
import { storageDomain, type RuntimeStorageView, type StorageReclaimResult } from "../../../../../src/protocol/modules/reclaim-storage.js"
import type { StorageReclaimPreview } from "../../../../../src/protocol/store-reclaim.js"
import type { FrontendMutation } from "../../../../../src/protocol/runtime/app-service-types.js"
const [{ testRender }, { createSignal }, { createComponent }, { ThemeProvider }, { createReclaimStorageSurface }, { createModalStack }] = await Promise.all([
  import("@opentui/solid"), import("solid-js"), import("solid-js/web"), import("../../../../../src/tui/context/theme.js"),
  import("../../../../../src/tui/modules/reclaim-storage/surface.js"), import("../../../../../src/tui/components/modal-stack.js"),
])

const GiB = 1024 * 1024 * 1024

async function openSurface(preview: StorageReclaimPreview, reclaim: StorageReclaimResult = { ok: true }) {
  const commands: FrontendMutation[] = []
  const modal = createModalStack()
  let answered = preview
  let previewReads = 0
  const [view, setView] = createSignal<RuntimeStorageView>({ usage: null, lastReclaim: { outcome: { kind: "reclaimed", beforeBytes: 4 * GiB, afterBytes: GiB, rowsDeleted: 10 }, at: 1 } })
  const read = moduleDomainReader((domain) => domain.domain === storageDomain.domain ? view() : undefined)
  function Surface() {
    createReclaimStorageSurface({
      modal, read,
      client: { query: runtimeQuery({ "storage.reclaimPreview": async () => { previewReads++; return answered } }), dispatch: recordedDispatch((command) => commands.push(command), runtimeDispatch({ "storage.reclaim": async () => reclaim })) },
    })()
    const entry = modal.stack[0]
    if (!entry) throw new Error("Reclaim storage did not open")
    return typeof entry.element === "function" ? entry.element() : entry.element
  }
  const rendered = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(Surface, {}) } }), { width: 90, height: 30 })
  const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); await rendered.renderOnce(); await rendered.renderOnce() }
  const press = async (name: string) => { modal.stack[0]?.onKey?.({ name }); await settle() }
  await settle()
  // Joined without frame borders, so a check reads wrapped sentences whole.
  const frame = () => rendered.captureCharFrame().split("\n").map((line) => line.replace(/[│╭╮╰╯─]/g, "").trim()).filter(Boolean).join(" ")
  return {
    rendered, commands, press, frame, settle,
    previewReads: () => previewReads,
    /** The service measures `next`, publishes `published`, and the next preview read answers `next`. */
    publish(next: StorageReclaimPreview, published: RuntimeStorageView) { answered = next; setView(published) },
  }
}

const preview = { storeBytes: 6 * GiB, reclaimableBytes: 3 * GiB, freeBytes: Math.round(16.8 * GiB), neededBytes: Math.round(3.1 * GiB) }

test("shows the preview and the last run, and Enter sends the run and reports it started", async () => {
  const surface = await openSurface(preview)
  try {
    const frame = surface.frame()
    expect(frame).toContain("Reclaim storage")
    expect(frame).toContain("Store: 6.0 GiB")
    expect(frame).toContain("Reclaimable: 3.0 GiB")
    expect(frame).toContain("Free disk: 16.8 GiB (needs 3.1 GiB)")
    expect(frame).toContain("Last run: Reclaimed 3.0 GiB: 4.0 GiB to 1.0 GiB")
    expect(frame).toContain("Its sessions pause and continue on their next message.")
    await surface.press("return")
    expect(surface.commands).toEqual([{ type: "storage.reclaim" }])
    expect(surface.frame()).toContain("Reclaiming storage. The project opens again when it is done.")
    await surface.press("return")
    expect(surface.commands).toHaveLength(1)
  } finally { surface.rendered.renderer.destroy() }
})

test("when the run's outcome lands, the preview reads again and the sizes and confirm patch in place", async () => {
  const surface = await openSurface(preview)
  try {
    await surface.press("return")
    expect(surface.frame()).toContain("Reclaiming storage.")
    const after = { ...preview, storeBytes: 3 * GiB, reclaimableBytes: 0 }
    const outcome = { kind: "reclaimed" as const, beforeBytes: 6 * GiB, afterBytes: 3 * GiB, rowsDeleted: 4 }
    surface.publish(after, { usage: { storeBytes: 3 * GiB, reclaimableBytes: 0 }, lastReclaim: { outcome, at: 2 } })
    await surface.settle()
    expect(surface.frame()).toContain("Store: 3.0 GiB")
    expect(surface.frame()).toContain("Reclaimable: 0 B")
    expect(surface.frame()).toContain("Last run: Reclaimed 3.0 GiB: 6.0 GiB to 3.0 GiB")
    expect(surface.frame()).not.toContain("Reclaiming storage.")
    // The same sizes published again read nothing more.
    const reads = surface.previewReads()
    surface.publish(after, { usage: { storeBytes: 3 * GiB, reclaimableBytes: 0 }, lastReclaim: { outcome, at: 2 } })
    await surface.settle()
    expect(surface.previewReads()).toBe(reads)
  } finally { surface.rendered.renderer.destroy() }
})

test("a refusal shows its reason and offers no confirm", async () => {
  const surface = await openSurface({ ...preview, refusal: "Free 3.1 GiB of disk space first." })
  try {
    expect(surface.frame()).toContain("Free 3.1 GiB of disk space first.")
    expect(surface.frame()).not.toContain("Its sessions pause")
    await surface.press("return")
    expect(surface.commands).toEqual([])
  } finally { surface.rendered.renderer.destroy() }
})

test("a refused run shows the error, and a missing store offers no confirm", async () => {
  const refused = await openSurface(preview, { ok: false, error: "The store is busy." })
  try {
    await refused.press("return")
    expect(refused.frame()).toContain("The store is busy.")
    expect(refused.frame()).not.toContain("Reclaiming storage.")
  } finally { refused.rendered.renderer.destroy() }
  const missing = await openSurface(null)
  try {
    expect(missing.frame()).toContain("This project holds no Flywheel store, or no Flywheel service serves it.")
    await missing.press("return")
    expect(missing.commands).toEqual([])
  } finally { missing.rendered.renderer.destroy() }
})
