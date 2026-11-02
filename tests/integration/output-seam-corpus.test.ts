import { describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreAppend } from "../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js"
import { createSessionDetailProjection } from "../../src/orchestration/app-service/session-detail-projection.js"
import { createConversationTree } from "../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { readSessionMetadata } from "../../src/orchestration/session/session-metadata-store.js"
import { appendOutputSeamCorpusFacts, assertCorpusSanitized, corruptPersistedCreation, parseOutputSeamCorpus, parseOutputSeamManifest, longestAgentOutput, openOutputSeamCorpus, refreshOutputSeamCorpus, SANITIZED_PROJECT_DIR, serializeOutputSeamCorpus, type CorpusCase } from "../../scripts/regenerate-output-seam-corpus.js"
import { tolerantReprojectionFixtures } from "../fixtures/tolerant-reprojection-fixtures.js"

type JsonScalar = string | number | boolean | null | undefined
interface JsonObject { [key: string]: JsonValue }
type JsonValue = JsonScalar | JsonObject | JsonValue[]
const corpusPath = "tests/fixtures/output-seam-corpus/corpus.json"
const manifestPath = "tests/fixtures/output-seam-corpus/manifest.json"
const generatorPath = "scripts/regenerate-output-seam-corpus.ts"

/** The committed corpus states one sanitized project directory, and session
 *  metadata states a canonical absolute directory (ARCH-DIRECTORIES-006). No single string
 *  is canonical on every platform: an absolute Windows path names a drive, so a
 *  POSIX-rooted directory does not equal its own resolution there. The two
 *  cases that replay or regenerate the committed bytes therefore only hold on
 *  the platform that wrote them; everything else in this file is
 *  platform-neutral and runs everywhere. */
const onCorpusPlatform = it.skipIf(process.platform === "win32")

describe("committed output seam corpus", () => {
  it("attaches every required category to executable case artifacts", async () => {
    const manifest = parseOutputSeamManifest(await Bun.file(manifestPath).json())
    const corpus = parseOutputSeamCorpus(await Bun.file(corpusPath).json())
    expect(corpus.cases).toHaveLength(11)
    const required = ["failed-tool", "partial-tool", "esc-tombstone", "compaction", "tool-group", "tool-body-preview", "workflow-output", "bounded-seed-eviction", "queued-message-recall", "old-session-created-v1", "retired-field", "unknown-version", "newer-version-fence", "corrupt-json-creation", "decoration-fact-failure", "mutation-before-creation", "reconcile-tombstone"]
    const mapped = new Set<string>()
    for (const selection of manifest.cases) {
      const corpusCase = corpus.cases.find((item) => item.id === selection.id)
      expect(corpusCase).toBeDefined()
      for (const [category, artifacts] of Object.entries(selection.coverage)) {
        mapped.add(category)
        for (const artifact of artifacts) {
          expect(selection.artifacts).toContain(artifact)
          expect(corpusCase?.artifacts).toHaveProperty(artifact)
        }
      }
    }
    expect([...mapped].sort()).toEqual([...required].sort())
    const bytes = await Bun.file(corpusPath).text()
    assertCorpusSanitized(bytes, manifest)
  })

  it("stays within the reviewed corpus caps", async () => {
    const bytes = await Bun.file(corpusPath).text()
    const corpus = parseOutputSeamCorpus(JSON.parse(bytes))
    const aliases = new Set(Array.from(bytes.matchAll(/(?:sanitized-(?:case-(?:session|conversation)|uuid)|alias)-[A-Za-z0-9-]+/g), (match) => match[0]))
    expect(corpus.cases.length).toBeLessThanOrEqual(12)
    expect(corpus.cases.reduce((total, item) => total + item.facts.length, 0)).toBeLessThanOrEqual(1_000)
    expect(aliases.size).toBeLessThanOrEqual(2_000)
    expect(Buffer.byteLength(bytes, "utf8")).toBeLessThanOrEqual(2_000_000)
  })

  it("rejects mixed, incomplete, unknown, and ambiguous source variants", () => {
    const base = { id: "bad", coverage: {}, artifacts: [] }
    for (const source of [
      { kind: "inline" },
      { kind: "mystery", fixtureId: "old-session-created-v1" },
      { kind: "inline", fixtureId: "old-session-created-v1", sessionId: "mixed" },
      { kind: "extracted", sessionId: "source", maxPosition: 1, fixtureId: "mixed" },
    ]) {
      expect(() => parseOutputSeamManifest({ version: 3, source: "test", cases: [{ ...base, source }] })).toThrow("Invalid output-seam source")
    }
  })

  onCorpusPlatform("exactly replays committed history, range, and identity wires through production", async () => {
    const corpus = parseOutputSeamCorpus(await Bun.file(corpusPath).json())
    for (const corpusCase of corpus.cases) {
      const root = mkdtempSync(join(tmpdir(), "flywheel-corpus-replay-"))
      const path = join(root, "facts.sqlite")
      let store = openOutputSeamCorpus(corpusCase, root)
      try {
        if (corpusCase.id === "corrupt-json-creation") {
          store.close()
          corruptPersistedCreation(path, corpusCase.sessionId, tolerantReprojectionFixtures.session_metadata.failures["invalid JSON"].payloadBytes)
          store = createSqliteEventStore(path)
        }
        if ("decorationOutcomes" in corpusCase.artifacts) {
          const outcomes = array(corpusCase.artifacts.decorationOutcomes).map(record)
          expect(outcomes.map((outcome) => outcome.entrypoint)).toEqual(["readToolResultDisplayMeta", "readSubagentRunsByToolUseId"])
          expect(outcomes.every((outcome) => outcome.kind === "success" && outcome.omittedMalformedDecoration === true && typeof outcome.decorationCount === "number")).toBe(true)
          continue
        }
        const projection = createSessionDetailProjection({
          projectRoot: root,
          sessionStore: { get: () => undefined },
          manager: { read: async (id) => id === corpusCase.sessionId ? (corpusCase.source.kind === "inline" ? await readSessionMetadata(asAsyncEventReadSurface(store), id) : extractedMetadata(corpusCase, root)) : readSessionMetadata(asAsyncEventReadSurface(store), id) },
          reader: asAsyncEventReadSurface(store),
          projectionReader: asAsyncEventReadSurface(store),
        })
        if ("range" in corpusCase.artifacts) expect(normalizeProjectionRoot(await projection.outputRange(corpusCase.sessionId, corpusCase.requests.range), root)).toEqual(corpusCase.artifacts.range)
        const agent = "agentRange" in corpusCase.artifacts ? await longestAgentOutput(projection, asAsyncEventReadSurface(store), corpusCase) : undefined
        if ("agentRange" in corpusCase.artifacts) expect(normalizeProjectionRoot(JSON.parse(JSON.stringify(agent?.range)), root)).toEqual(corpusCase.artifacts.agentRange)
        if ("boundedRange" in corpusCase.artifacts) expect(normalizeProjectionRoot(await projection.outputRange(corpusCase.sessionId, { anchor: { kind: "tail" }, maxBlocks: 4, maxBytes: 4096 }), root)).toEqual(corpusCase.artifacts.boundedRange)
        const range = record(corpusCase.artifacts.agentRange ?? corpusCase.artifacts.range)
        const outputSessionId = agent?.sessionId ?? corpusCase.sessionId
        const blocks = range.kind === "ok" ? array(range.blocks).map(record) : []
        if ("groupChildren" in corpusCase.artifacts) {
          const group = blocks.find((block) => block.kind === "agentGroup")
          if (!group) throw new Error(`Missing group in ${corpusCase.id}`)
          expect(normalizeProjectionRoot(await projection.outputGroupChildren(outputSessionId, { groupBlockIds: [`tool:${string(group.id)}`], maxBytes: 1024 * 1024 }), root)).toEqual(corpusCase.artifacts.groupChildren)
        }
        if ("toolBody" in corpusCase.artifacts) {
          const tool = blocks.find((block) => block.kind === "tool" && (block.content !== undefined || block.diff !== undefined)) ?? blocks.find((block) => block.kind === "tool")
          if (!tool) throw new Error(`Missing tool in ${corpusCase.id}`)
          expect(normalizeProjectionRoot(await projection.outputBlockBody(outputSessionId, { blockId: `tool:${string(tool.id)}` }), root)).toEqual(corpusCase.artifacts.toolBody)
        }
      } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
    }
  })

  onCorpusPlatform("self-refreshes derived artifacts deterministically from committed sanitized facts", async () => {
    const committedBytes = await Bun.file(corpusPath).text()
    const committed = parseOutputSeamCorpus(JSON.parse(committedBytes))
    const sourceRoot = mkdtempSync(join(tmpdir(), "flywheel-corpus-source-"))
    try {
      const manifest = parseOutputSeamManifest(await Bun.file(manifestPath).json())
      const first = await refreshOutputSeamCorpus(committed, manifest, join(sourceRoot, "first"))
      const second = await refreshOutputSeamCorpus(committed, manifest, join(sourceRoot, "second"))
      const firstBytes = serializeOutputSeamCorpus(first, manifest)
      expect(first.cases.map((item) => item.facts)).toEqual(committed.cases.map((item) => item.facts))
      expect(firstBytes).toBe(serializeOutputSeamCorpus(second, manifest))
      expect(firstBytes).toBe(committedBytes)
    } finally { rmSync(sourceRoot, { recursive: true, force: true }) }
  })
})

describe("output seam corpus generator entrypoint", () => {
  onCorpusPlatform("refreshes an existing corpus without a source store and preserves facts deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-corpus-entrypoint-refresh-"))
    const temporaryManifestPath = join(root, "manifest.json")
    const outputPath = join(root, "corpus.json")
    try {
      const manifestBytes = await Bun.file(manifestPath).text()
      const committedBytes = await Bun.file(corpusPath).text()
      writeFileSync(temporaryManifestPath, manifestBytes)
      writeFileSync(outputPath, committedBytes)
      const before = parseOutputSeamCorpus(JSON.parse(committedBytes))

      const first = runGenerator("--manifest", temporaryManifestPath, "--output", outputPath)
      expect(first.stdout).toContain("refreshed 11 sanitized output-seam cases")
      const firstBytes = await Bun.file(outputPath).text()
      const firstCorpus = parseOutputSeamCorpus(JSON.parse(firstBytes))
      expect(firstCorpus.cases.map((item) => item.facts)).toEqual(before.cases.map((item) => item.facts))

      const second = runGenerator("--manifest", temporaryManifestPath, "--output", outputPath)
      expect(second.stdout).toContain("refreshed 11 sanitized output-seam cases")
      expect(await Bun.file(outputPath).text()).toBe(firstBytes)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("uses explicit --store extraction against the requested source and output paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-corpus-entrypoint-extract-"))
    const sourcePath = join(root, "source.sqlite")
    const temporaryManifestPath = join(root, "manifest.json")
    const outputPath = join(root, "corpus.json")
    const sourceCorpus = parseOutputSeamCorpus(await Bun.file(corpusPath).json())
    const sourceCase = sourceCorpus.cases[0]
    if (!sourceCase?.conversationId) throw new Error("Expected extracted chat corpus fixture")
    const source = createSqliteEventStore(sourcePath)
    try {
      appendOutputSeamCorpusFacts(source, sourceCase)
    } finally { source.close() }
    try {
      writeFileSync(temporaryManifestPath, JSON.stringify({
        version: sourceCorpus.version,
        source: sourcePath,
        cases: [{
          id: sourceCase.id,
          source: { kind: "extracted", sessionId: sourceCase.sessionId, conversationId: sourceCase.conversationId, maxPosition: Number.MAX_SAFE_INTEGER },
          coverage: {},
          artifacts: [],
        }],
      }))
      writeFileSync(outputPath, "{}")

      const result = runGenerator("--store", sourcePath, "--manifest", temporaryManifestPath, "--output", outputPath)
      expect(result.stdout).toContain("extracted 1 sanitized output-seam cases")
      const extracted = parseOutputSeamCorpus(await Bun.file(outputPath).json())
      expect(extracted.cases).toHaveLength(1)
      expect(extracted.cases[0]?.source).toEqual({ kind: "extracted" })
      expect(extracted.cases[0]?.facts).toEqual(sourceCase.facts)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

/** Sanitized replay of a durable edit whose diff outgrew the wire preview. The
 *  generated corpus cannot carry it: its sanitizer rewrites every `diff` value
 *  to a one-line placeholder, so the truncation seam has no committed case. The
 *  facts here are authored sanitized and asserted so by the same guard the
 *  committed corpus uses. */
describe("sanitized historical edit replay", () => {
  const sessionId = "corpus-edit-session"
  const conversationId = "corpus-edit-conversation"
  const hunkHeaders = [
    "--- a/src/sanitized-example.ts",
    "+++ b/src/sanitized-example.ts",
    "@@ -1,3 +1,3 @@",
    " const first = 1",
    "-const second = 2",
    "+const second = 3",
    "@@ -10,20 +10,20 @@",
  ]
  const fillerLines = Array.from({ length: 23 }, (_, index) => ` const filler${index} = ${index}`)
  const fullDiff = [...hunkHeaders, ...fillerLines].join("\n")

  it("replays a wire-truncated historical edit and expands it to the full diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-corpus-edit-"))
    const store = createSqliteEventStore(join(root, "facts.sqlite"))
    try {
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const appended = await tree.appendMessages([
        { kind: "user", content: "sanitized request" },
        { kind: "assistant", content: [{ type: "tool_use", id: "edit-1", name: "edit", input: { input: "@@ src/sanitized-example.ts\n= 2aa..2aa\n~const second = 3" } }] },
        { kind: "toolResult", toolUseId: "edit-1", content: [{ type: "text", text: "Sanitized recorded content" }] },
      ])
      if (appended.kind !== "committed") throw new Error("expected committed edit entries")
      tree.getStorage().dispose()
      const resultFact: EventStoreAppend = {
        aggregateId: `session:${sessionId}`,
        type: "tool.result.recorded",
        version: 1,
        timestamp: 1_700_000_000_000,
        actor: "flywheel",
        sessionId,
        payload: { toolUseId: "edit-1", outcome: "ok", details: { diff: fullDiff, filetype: "typescript" } },
      }
      assertCorpusSanitized(JSON.stringify(resultFact), { version: 2, source: "authored-sanitized-facts", cases: [] })
      store.append(resultFact)

      const projection = createSessionDetailProjection({
        projectRoot: root,
        sessionStore: { get: () => undefined },
        manager: { read: async (id) => id === sessionId ? editSessionMetadata(conversationId, root) : null },
        reader: asAsyncEventReadSurface(store),
        projectionReader: asAsyncEventReadSurface(store),
      })
      const range = await projection.outputRange(sessionId, { anchor: { kind: "tail" }, maxBlocks: 12, maxBytes: 32_768 })
      if (range.kind !== "ok") throw new Error("expected a replayed edit range")
      const tool = range.blocks.find((block) => block.kind === "tool")
      if (tool?.kind !== "tool") throw new Error("expected a replayed edit tool block")

      expect(tool.name).toBe("edit")
      expect(tool.status).toBe("completed")
      expect(tool.diff).toBe([...hunkHeaders, ...fillerLines.slice(0, 17)].join("\n"))
      expect(tool.diffOmission).toEqual({ kind: "aggregate", omittedLines: 6 })

      expect(await projection.outputBlockBody(sessionId, { blockId: `tool:${tool.id}` })).toEqual({
        blockId: "tool:edit-1",
        diff: fullDiff,
        filetype: "typescript",
      })
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})

function editSessionMetadata(conversationId: string, executionCwd: string) {
  return { label: "Sanitized session", lastUpdated: "2023-11-14T22:13:20.000Z", lifecycleState: "inactive" as const, name: "Sanitized session", kind: "chat" as const, command: "chat" as const, conversationId, executionCwd }
}

function extractedMetadata(corpusCase: CorpusCase, executionCwd: string) {
  const created = corpusCase.facts.find((fact) => fact.type === "session.created")
  if (!created) throw new Error(`Case ${corpusCase.id} has no session.created fact`)
  const common = { label: "Sanitized session", lastUpdated: "2023-11-14T22:13:20.000Z", lifecycleState: "inactive" as const, name: "Sanitized session", executionCwd }
  return corpusCase.kind === "chat" ? { ...common, kind: "chat" as const, command: "chat" as const, conversationId: string(corpusCase.conversationId) } : null
}

function normalizeProjectionRoot(value: unknown, root: string): JsonValue {
  return normalizeProjectionValue(JSON.parse(JSON.stringify(value)), realpathSync(root))
}

function normalizeProjectionValue(value: JsonValue, root: string): JsonValue {
  if (typeof value === "string") return value.replaceAll(root, SANITIZED_PROJECT_DIR).replace(/(?:\.\.\/)+tmp\/flywheel-uat-tabswitch\.sh/g, "../../tmp/flywheel-uat-tabswitch.sh")
  if (Array.isArray(value)) return value.map((item) => normalizeProjectionValue(item, root))
  if (!value || typeof value !== "object") return value
  const source = record(value)
  const normalized = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, normalizeProjectionValue(item, root)]))
  const sourceWindow = source.window
  if (Array.isArray(source.blocks) && sourceWindow && typeof sourceWindow === "object" && !Array.isArray(sourceWindow)) {
    const normalizedWindow = record(normalized.window)
    if (typeof normalizedWindow.contentBytes === "number") {
      const contentBytesDelta = metricRelevantLengthDelta(source.blocks, normalized.blocks)
      normalized.window = { ...normalizedWindow, contentBytes: normalizedWindow.contentBytes + contentBytesDelta }
    }
  }
  return normalized
}

function metricRelevantLengthDelta(source: JsonValue, normalized: JsonValue, key = ""): number {
  if (typeof source === "string" && typeof normalized === "string") return key === "detail" ? normalized.length - source.length : 0
  if (Array.isArray(source) && Array.isArray(normalized)) return source.reduce<number>((sum, item, index) => sum + metricRelevantLengthDelta(item, normalized[index]), 0)
  if (!source || !normalized || typeof source !== "object" || typeof normalized !== "object" || Array.isArray(source) || Array.isArray(normalized)) return 0
  const sourceRecord = record(source)
  const normalizedRecord = record(normalized)
  return Object.entries(sourceRecord).reduce((sum, [childKey, item]) => sum + metricRelevantLengthDelta(item, normalizedRecord[childKey], childKey), 0)
}
function record(value: JsonValue): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value }
function array(value: JsonValue): JsonValue[] { if (!Array.isArray(value)) throw new Error("Expected array"); return value }
function string(value: JsonValue): string { if (typeof value !== "string") throw new Error("Expected string"); return value }

function runGenerator(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, generatorPath, ...args], { cwd: process.cwd(), windowsHide: true })
  if (!result.success) throw new Error(result.stderr.toString())
  return { stdout: result.stdout.toString() }
}