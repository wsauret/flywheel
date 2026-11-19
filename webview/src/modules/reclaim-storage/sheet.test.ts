import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("sheet-fixture.ts", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "storage-memory-host", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find(item => item.kind === "entry-point")
if (!output) throw new Error("Missing storage fixture build")
const { mountReclaimStorage }: typeof import("./sheet-fixture.js") = await importBuiltModule(output)

const GiB = 1024 ** 3
const preview = { storeBytes: 5 * GiB, reclaimableBytes: 2 * GiB, freeBytes: 16 * GiB, neededBytes: 3 * GiB }
const refused = { kind: "refused" as const, reason: "busy" as const, message: "A reclaim already runs." }

test("the preview shows the store, and a confirmed run sends one reclaim and keeps its nodes as the last run changes", async () => {
  const mounted = mountReclaimStorage({ preview, view: { usage: null, lastReclaim: { outcome: refused, at: 1 } } })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /Store5\.0 GiB/)
    assert.match(mounted.text(), /Reclaimable2\.0 GiB/)
    assert.match(mounted.text(), /Free disk16\.0 GiB \(needs 3\.0 GiB\)/)
    assert.match(mounted.text(), /Last runA reclaim already runs\.refused: busy/)
    assert.match(mounted.text(), /The project closes while its store is rebuilt/)
    const last = mounted.row("Last run")
    const confirm = mounted.button("Reclaim storage")
    assert.ok(last && confirm)
    mounted.publish({ usage: null, lastReclaim: { outcome: { kind: "reclaimed", beforeBytes: 4 * GiB, afterBytes: GiB, rowsDeleted: 9 }, at: 2 } })
    assert.equal(mounted.row("Last run"), last)
    assert.match(mounted.text(), /Last runReclaimed 3\.0 GiB: 4\.0 GiB to 1\.0 GiBreclaimed 3\.0 GiB/)
    mounted.click("Reclaim storage")
    mounted.click("Reclaim storage")
    await mounted.settle()
    assert.deepEqual(mounted.mutations, [{ type: "storage.reclaim" }])
    assert.equal(mounted.button("Reclaim storage"), confirm)
    assert.equal(confirm.properties.disabled, true)
    assert.match(mounted.text(), /Reclaiming storage\. The project opens again when it is done\./)
  } finally { mounted.dispose() }
})

test("when the run's outcome lands, the preview reads again and the sizes and confirmation patch in place", async () => {
  const mounted = mountReclaimStorage({ preview })
  try {
    await mounted.settle()
    mounted.click("Reclaim storage")
    await mounted.settle()
    const confirm = mounted.button("Reclaim storage")
    const store = mounted.row("Store")
    assert.equal(confirm?.properties.disabled, true)
    mounted.measure({ ...preview, storeBytes: 3 * GiB, reclaimableBytes: 0 })
    const after = { usage: { storeBytes: 3 * GiB, reclaimableBytes: 0 }, lastReclaim: { outcome: { kind: "reclaimed" as const, beforeBytes: 5 * GiB, afterBytes: 3 * GiB, rowsDeleted: 4 }, at: 2 } }
    mounted.publish(after)
    await mounted.settle()
    assert.match(mounted.text(), /Store3\.0 GiB/)
    assert.match(mounted.text(), /Reclaimable0 B/)
    assert.doesNotMatch(mounted.text(), /Reclaiming storage\./)
    assert.equal(mounted.row("Store"), store)
    assert.equal(mounted.button("Reclaim storage"), confirm)
    assert.equal(confirm?.properties.disabled, false)
    const reads = mounted.previewReads()
    mounted.publish({ ...after })
    await mounted.settle()
    assert.equal(mounted.previewReads(), reads)
  } finally { mounted.dispose() }
})

test("a refusal shows its reason and no confirmation", async () => {
  const mounted = mountReclaimStorage({ preview: { ...preview, refusal: "Free 3.0 GiB of disk space first." } })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /Free 3\.0 GiB of disk space first\./)
    assert.equal(mounted.paragraph("Free 3.0 GiB")?.properties.class, "reclaim-storage-warning")
    assert.doesNotMatch(mounted.text(), /The project closes/)
    assert.equal(mounted.button("Reclaim storage"), undefined)
  } finally { mounted.dispose() }
})

test("a project with no store says so and offers no confirmation", async () => {
  const mounted = mountReclaimStorage({ preview: null })
  try {
    await mounted.settle()
    assert.match(mounted.text(), /This project holds no Flywheel store, or no Flywheel service serves it\./)
    assert.equal(mounted.button("Reclaim storage"), undefined)
  } finally { mounted.dispose() }
})

test("a refused run shows its error and leaves the confirmation available", async () => {
  const mounted = mountReclaimStorage({ preview, result: { ok: false, error: "Sessions of this project are still running." } })
  try {
    await mounted.settle()
    mounted.click("Reclaim storage")
    await mounted.settle()
    assert.match(mounted.text(), /Sessions of this project are still running\./)
    assert.equal(mounted.paragraph("Sessions of this project")?.properties.role, "alert")
    assert.equal(mounted.button("Reclaim storage")?.properties.disabled, false)
  } finally { mounted.dispose() }
})
