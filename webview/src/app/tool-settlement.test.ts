import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import { afterAll } from "bun:test"
import { mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"

const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
  constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() { this.callback([{ isIntersecting: true }]) }
  disconnect() {}
} })
afterAll(() => {
  if (originalObserver) Object.defineProperty(globalThis, "IntersectionObserver", originalObserver)
  else Reflect.deleteProperty(globalThis, "IntersectionObserver")
})

async function retained(diff: Parameters<typeof mutationEvidenceFixture>[0], options?: Parameters<typeof mutationEvidenceFixture>[1]) {
  const stored = await mutationEvidenceFixture(diff, options)
  // Collapsed rows render from the previews of the metadata page.
  await stored.reader.open(command.id, stored.evidence.manifest, { previews: true }).loadFiles()
  return stored
}

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("tool-settlement-fixture.tsx", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "tool-settlement-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((candidate) => candidate.kind === "entry-point")
if (!output) throw new Error("Tool settlement fixture build produced no JavaScript")
const fixture: typeof import("./tool-settlement-fixture.js") = await importBuiltModule(output)

const command: FrontendToolEntry = {
  kind: "tool",
  id: "bash-1",
  name: "bash",
  action: "shell_exec",
  presentation: { name: "Bash", detail: "reshape" },
  status: "completed",
  timestamp: 1,
  exitCode: 0,
  content: "command output line",
}
const mutation = { version: 1 as const, files: [{ path: "src/a.ts", change: "modified" as const, unifiedDiff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n" }], omissions: [] }

const shellMutation: FrontendToolEntry = { ...command, status: "pending", declaresMutation: true }

test("Write source survives streaming settlement while patch additions stay diffs", async () => {
  for (const fileChangeKind of ["create", "patch"] as const) {
    const file = { path: "src/new.ts", change: "added" as const, unifiedDiff: "@@ -0,0 +1 @@\n+const created = true\n" }
    const entry: FrontendToolEntry = {
      ...command, name: fileChangeKind === "create" ? "write" : "apply_patch", fileChangeKind, status: "streaming",
      proposedDiff: { files: [{
        id: "file-0", path: file.path, action: "add",
        hunks: [{ id: "hunk-0", newStart: 1, omittedBefore: 0, omittedAfter: 0, lines: [{ id: "line-0", kind: "add", text: "const created = true", partial: false }] }],
      }] },
    }
    const stored = await retained({ version: 1, files: [file], omissions: [] })
    const row = fixture.mountToolRow(entry, stored.reader)
    try {
      row.open()
      for (const settled of [false, true]) {
        if (settled) row.settle({ ...entry, status: "completed", mutationEvidence: stored.evidence })
        const rendered = row.files()[0]!
        if (fileChangeKind === "create") {
          assert.match(rendered.html, /hljs-keyword/)
          assert.doesNotMatch(rendered.html, /diff-marker|diff-add/)
        } else {
          assert.match(rendered.html, /diff-marker/)
          assert.doesNotMatch(rendered.html, /hljs-keyword/)
        }
      }
    } finally {
      row.dispose(); stored.reader.dispose()
    }
  }
})

test("added shell files use Write source and its palette while mixed rows keep Edit and modified diffs", async () => {
  const added = { path: "src/new.ts", change: "added" as const, unifiedDiff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+const created = true\n" }
  for (const mixed of [false, true]) {
    const stored = await retained({ ...mutation, files: mixed ? [added, ...mutation.files] : [added] })
    const row = fixture.mountToolRow(shellMutation, stored.reader)
    try {
      row.settle({ ...shellMutation, status: "completed", mutationEvidence: stored.evidence })
      row.open()
      assert.match(row.text(), mixed ? /^▾Editsrc\/new\.ts, src\/a\.ts/ : /^▾Writesrc\/new\.ts/)
      const [write] = row.files()
      assert.deepEqual(write!.classList, { "write-syntax": true })
      assert.match(JSON.stringify(write!.style), /--fw-write-syntax-keyword/)
      assert.match(write!.html, /hljs-keyword/)
      assert.doesNotMatch(write!.html, /diff-marker|diff-add/)
      if (mixed) {
        const [, edit] = row.files()
        assert.deepEqual(edit!.classList, { "write-syntax": false })
        assert.match(edit!.html, /diff-marker|diff-add/)
        assert.doesNotMatch(edit!.html, /hljs-keyword/)
      }
    } finally {
      row.dispose(); stored.reader.dispose()
    }
  }
})

test("a removed directory is one collapsed row that discloses the files it held", async () => {
  const deleted = (name: string) => ({ path: `scratch/dl/${name}`, change: "removed" as const, unifiedDiff: `--- a/scratch/dl/${name}\n+++ /dev/null\n@@ -1 +0,0 @@\n-held ${name}\n` })
  const stored = await retained({ ...mutation, files: [deleted("a.txt"), deleted("b.txt"), ...mutation.files] },
    { removedDirectories: [{ path: "scratch/dl", files: 2, bytes: 2048 }] })
  const row = fixture.mountToolRow(shellMutation, stored.reader)
  try {
    row.settle({ ...shellMutation, status: "completed", mutationEvidence: stored.evidence })
    row.open()
    assert.match(row.text(), /^▾Editscratch\/dl\/ \(2 files\), src\/a\.ts/)
    assert.match(row.text(), /scratch\/dl\/ \(delete, 2 files, 2 KB\) ▸/)
    assert.doesNotMatch(row.text(), /held a\.txt/)
    assert.equal(row.files().length, 1)
    row.click("scratch/dl/ (delete, 2 files, 2 KB) ▸")
    await stored.settle()
    assert.match(row.text(), /scratch\/dl\/ \(delete, 2 files, 2 KB\) ▾/)
    assert.equal(row.files().length, 3)
    assert.match(row.text(), /held a\.txt.*held b\.txt.*const a = 2/s)
  } finally {
    row.dispose(); stored.reader.dispose()
  }
})

test("a command that declares mutations is a running edit without its command while it runs, then names its files when they land, without its output", async () => {
  const stored = await retained(mutation)
  const row = fixture.mountToolRow(shellMutation, stored.reader)
  try {
    assert.match(row.text(), /^Editbash command is running…$/)
    row.settle({ ...shellMutation, status: "completed", mutationEvidence: stored.evidence })
    row.open()
    assert.match(row.text(), /^▾Editsrc\/a\.ts/)
    assert.match(row.text(), /const a = 2/)
    assert.doesNotMatch(row.text(), /reshape|command output line/)
  } finally {
    row.dispose(); stored.reader.dispose()
  }
})

test("a shell mutation that changed nothing settles as its plain command and opens its settled output", () => {
  const row = fixture.mountToolRow({ ...shellMutation, status: "completed", exitCode: 1 })
  try {
    assert.match(row.text(), /^▸Bashreshapeexit 1$/)
    assert.doesNotMatch(row.text(), /command output line/)
    row.open()
    assert.match(row.text(), /^▾Bashreshapeexit 1command output line$/)
  } finally {
    row.dispose()
  }
})

test("a command that never declares mutations stays a command with its output", () => {
  const row = fixture.mountToolRow(command)
  try {
    row.open()
    assert.match(row.text(), /^▾Bashreshapecommand output line/)
  } finally {
    row.dispose()
  }
})
