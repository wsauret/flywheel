import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { relative, resolve } from "node:path"
import ledger from "../src/orchestration/app-service/web-serving/upstream-ledger.json"

// Run after inspiration/openclaw is synced. An optional checkout path supports an isolated audit.
const repositoryRoot = resolve(import.meta.dir, "..")
const sourceRoot = resolve(repositoryRoot, "inspiration/openclaw")
const checkout = resolve(process.argv[2] ?? sourceRoot)

for (const copy of ledger.copies) {
  const source = await Bun.file(resolve(checkout, relative(sourceRoot, resolve(repositoryRoot, copy.source)))).text()
  const start = source.indexOf(copy.startMarker)
  const end = source.indexOf(copy.endMarker, start)
  assert.ok(start >= 0, `${copy.source}: start marker missing`)
  assert.ok(end > start, `${copy.source}: end marker missing`)
  const slice = source.slice(start, end + copy.endMarker.length)
  assert.equal(
    createHash("sha256").update(slice).digest("hex"),
    copy.sourceSha256,
    `${copy.source}: upstream drift since ${ledger.upstream.revision}; review the adaptation and update its ledger and pinned fixture`,
  )
}

console.log(`Verified ${ledger.copies.length} source slices against reviewed revision ${ledger.upstream.revision}.`)
