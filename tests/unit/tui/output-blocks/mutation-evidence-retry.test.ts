import { expect, test } from "bun:test"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import { renderToolEntry } from "./_tool-entry-render.js"

const edit = { kind: "tool", id: "edit", name: "edit", status: "completed", fileChangeKind: "patch", presentation: { name: "Edit", detail: "example.ts" }, timestamp: 1 } as const

test("shows each refused file from the retained manifest, not only the summary samples", async () => {
  const notApplied = Array.from({ length: 4 }, (_, index) => ({ path: `refused-${index}.ts`, reason: "Changed outside this operation" }))
  const fixture = await mutationEvidenceFixture([], { notApplied })
  const result = await renderToolEntry({ ...edit, mutationEvidence: fixture.evidence }, { evidenceReader: fixture.reader })
  try {
    for (let index = 0; index < 4; index++) { await result.renderOnce(); await fixture.settle() }
    for (const file of notApplied) expect(result.captureCharFrame()).toContain(`${file.path} not applied`)
  } finally { result.renderer.destroy(); fixture.reader.dispose() }
})

test.each(["files", "patch"] as const)("retries a transient %s read only through its Retry action", async phase => {
  const fixture = await mutationEvidenceFixture([{ path: "example.ts", patch: "@@ -1 +1 @@\n-old\n+new", lines: 2 }])
  if (phase === "files") fixture.failFiles(true)
  else fixture.failPatches("error")
  // Only an expanded file reads its patch bytes, so the patch phase starts with its file expanded.
  const disclosure = { disclosure: (key: string) => phase === "patch" && key.includes("#diff:") ? true : undefined, setDisclosure: () => {} }
  const result = await renderToolEntry({ ...edit, mutationEvidence: fixture.evidence }, { evidenceReader: fixture.reader, disclosure })
  try {
    for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
    const frame = result.captureCharFrame()
    expect(frame).toContain("Could not load change evidence.")
    expect(frame).toContain("Retry")
    expect(frame).not.toContain("Change evidence is unavailable")
    const before = fixture.calls.length
    for (let index = 0; index < 2; index++) await result.renderOnce()
    expect(fixture.calls).toHaveLength(before)
    fixture.failFiles(false); fixture.failPatches(undefined)
    const lines = frame.split("\n")
    const row = lines.findIndex(line => line.includes("Retry"))
    await result.mockMouse.moveTo(lines[row]!.indexOf("Retry") + 1, row)
    await result.renderOnce()
    await result.mockMouse.click(lines[row]!.indexOf("Retry") + 1, row)
    expect(fixture.calls.length).toBeGreaterThan(before)
    for (let index = 0; index < 4; index++) { await result.renderOnce(); await fixture.settle() }
    expect(result.captureCharFrame()).toContain("+new")
    expect(result.captureCharFrame()).not.toContain("Retry")
  } finally { result.renderer.destroy(); fixture.reader.dispose() }
})
