import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

interface Substitution {
  from: string
  to: string
  reason?: string
}

interface LedgerCopy {
  source: string
  target: string
  startMarker: string
  endMarker: string
  sha256: string
  substitutions: ReadonlyArray<Substitution>
}

interface UpstreamLedger {
  upstream: { repository: string; revision: string }
  copies: ReadonlyArray<LedgerCopy>
  notes: ReadonlyArray<string>
}

const repositoryRoot = resolve(import.meta.dir, "../../../../..")
const ledgerRelativePath = "src/orchestration/modules/experiments/upstream-ledger.json"
const upstreamRepository = "https://github.com/davebcn87/pi-autoresearch"
const upstreamRevision = "939ede8220daad440eac6bb7b6e315cc283e0a64"
const upstreamCheckout = resolve(repositoryRoot, "inspiration/pi-autoresearch")

/** Every deliberate non-port the spec approved. Each must be named in the ledger notes. */
const approvedOmissions = [
  "browser export HTTP server and assets/template.html",
  "shortcuts.ts",
  "hooks.ts",
  "hooks skill",
  "compaction.ts",
  "tool-result renderers",
  "paths.ts",
  ".auto/log.jsonl and .auto/config.json",
]

// The ledger is repository-owned JSON, so its shape is trusted here.
const readLedger = (): Promise<UpstreamLedger> =>
  Bun.file(resolve(repositoryRoot, ledgerRelativePath)).json()

const sha256 = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex")

const sliceOf = (source: string, copy: LedgerCopy): string | null => {
  const start = source.indexOf(copy.startMarker)
  if (start < 0) return null
  const end = source.indexOf(copy.endMarker, start)
  if (end < start) return null
  return source.slice(start, end + copy.endMarker.length)
}

/** The experiments module is a copy-and-edit port of the vendored
 *  pi-autoresearch checkout. This ledger locks each copied slice by its local
 *  source markers and SHA-256, so re-vendoring or editing a slice fails here
 *  until the copy is re-read against its new upstream. It never runs Git and
 *  never infers the pin from the parent repository. */
describe("experiments upstream ledger", () => {
  test("pins the approved repository and revision", async () => {
    const ledger = await readLedger()
    expect(ledger.upstream.repository).toBe(upstreamRepository)
    expect(ledger.upstream.revision).toBe(upstreamRevision)
    expect(ledger.copies.length).toBeGreaterThan(0)
  })

  test.skipIf(!existsSync(upstreamCheckout))("every copy has an unchanged local source slice, a target, and recorded substitutions", async () => {
    const ledger = await readLedger()
    const sources = new Map<string, string>()
    for (const [index, copy] of ledger.copies.entries()) {
      const row = `copies[${index}] ${copy.source} -> ${copy.target}`
      const sourcePath = resolve(repositoryRoot, copy.source)
      expect(await Bun.file(sourcePath).exists(), `${row}: source exists`).toBe(true)
      const source = sources.get(copy.source) ?? (await Bun.file(sourcePath).text())
      sources.set(copy.source, source)

      const slice = sliceOf(source, copy)
      expect(slice, `${row}: start and end markers`).not.toBeNull()
      expect(sha256(slice ?? ""), `${row}: source slice sha256`).toBe(copy.sha256)
      expect(await Bun.file(resolve(repositoryRoot, copy.target)).exists(), `${row}: target exists`).toBe(true)
      expect(copy.substitutions.length, `${row}: records its adaptation`).toBeGreaterThan(0)
      for (const substitution of copy.substitutions) {
        expect(substitution.from.length, `${row}: substitution from`).toBeGreaterThan(0)
        expect(substitution.to.length, `${row}: substitution to`).toBeGreaterThan(0)
      }
    }
  })

  test("notes name every approved non-port", async () => {
    const ledger = await readLedger()
    for (const omission of approvedOmissions) {
      expect(
        ledger.notes.some((note) => note.includes(omission)),
        `notes name omission: ${omission}`,
      ).toBe(true)
    }
  })
})
