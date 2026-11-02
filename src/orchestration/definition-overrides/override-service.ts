import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { writeFileAtomic } from "../../infra/atomic-write.js"
import { buildMutationDiff, type MutationDiff } from "../../infra/mutation-diff.js"
import type { BundledDefaultCatalog } from "../../workflows/definitions/bundled-defaults.js"
import type {
  CompleteOverrideContent,
  DefinitionOverride,
  DefinitionOverrideOperations,
  DefinitionStalenessReport,
  OverrideRebaseSource,
  OverrideResolutionAction,
  PreparedOverrideResolution,
  PreparedOverrideTarget,
} from "../../workflows/definitions/override-staleness.js"
import { packagePathRefusal } from "../../workflows/skill-package-path.js"
import type { DefinitionOverrideBaselineOwner } from "../../workflows/definitions/override-baselines.js"


export type DefinitionOverrideService = DefinitionOverrideOperations

export function createDefinitionOverrideService(options: {
  readonly catalog: BundledDefaultCatalog
  readonly baselines: Pick<DefinitionOverrideBaselineOwner, "set">
  readonly load: () => Promise<DefinitionStalenessReport>
}): DefinitionOverrideService {
  let report: DefinitionStalenessReport = { overrides: [], diagnostics: [] }
  const preparations = new Map<string, PreparedOverrideResolution>()
  const listeners = new Set<(report: DefinitionStalenessReport) => void>()

  const reload = async (): Promise<DefinitionStalenessReport> => {
    report = await options.load()
    for (const listener of listeners) listener(report)
    return report
  }
  const find = (path: string): DefinitionOverride => {
    const override = report.overrides.find((entry) => entry.path === path)
    if (!override) throw new Error(`Definition override is not in the current resolution: ${path}`)
    return override
  }

  return {
    available: () => report.overrides.some(({ status }) => status === "upstream-changed"),
    list: reload,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async diff(path) {
      await reload()
      const override = find(path)
      return diffForContents(override, currentContent(override, options.catalog), await overrideContent(override))
    },
    async prepare(path, action, proposed) {
      validateCompletePackage(proposed)
      if (action === "adopt-default" && proposed) throw new Error("Adopting the default takes no proposed result")
      report = await options.load()
      const unresolved = find(path)
      if (unresolved.family === "skill") await packageFiles(dirname(unresolved.path), true)
      await reload()
      const override = find(path)
      const target = await bindTarget(override)
      const source = action === "rebase" ? await rebaseSource(override, options.catalog) : undefined
      if (action === "rebase") validateProposed(target, proposed)
      const mine = await overrideContent(override)
      const theirs = currentContent(override, options.catalog)
      const resolvedResult = proposed ?? (action === "keep-mine" ? mine : undefined)
      const completeResult = resolvedResult ? cleanPublication(resolvedResult) : undefined
      // The diff is the change approval makes. Adopting the default replaces
      // mine with theirs. A rebase that has no result yet shows the review diff.
      const diff = action === "adopt-default"
        ? diffForContents(override, mine, theirs)
        : diffForContents(override, completeResult ? mine : theirs, completeResult ?? mine)
      const preparedWithoutId = { action, target, ...(source ? { source } : {}), ...(completeResult ? { proposed: completeResult } : {}), diff }
      const preparationId = sha256(JSON.stringify(preparedWithoutId))
      const prepared = { preparationId, ...preparedWithoutId, summary: preparationSummary(override, action, diff) }
      preparations.set(prepared.preparationId, prepared)
      return prepared
    },
    async apply(preparation) {
      await reload()
      const prepared = preparations.get(preparation.preparationId)
      if (!prepared || JSON.stringify(prepared) !== JSON.stringify(preparation)) throw new Error("Override preparation is stale or invalid")
      preparations.delete(preparation.preparationId)
      const override = find(preparation.target.path)
      if (preparation.target.kind === "skill-package") throw new Error("Skill packages must publish through the complete-package mutation writer")
      const currentTarget = await bindTarget(override)
      if (!targetsEqual(currentTarget, preparation.target)) throw new Error("Definition override changed after preparation")

      if (preparation.action === "adopt-default") {
        await rm(override.family === "skill" ? dirname(override.path) : override.path, { recursive: override.family === "skill", force: true })
        if (override.family !== "skill") await rm(override.snapshotPath, { force: true })
      } else {
        if (!preparation.proposed) throw new Error("A keep or rebase resolution requires the complete clean result")
        await writeProposed(override, preparation.proposed)
        await replaceSnapshot(override, options.catalog)
      }
      await options.baselines.set(override.path, override.currentDefaultHash)
      await reload()
    },
    refresh: async () => { await reload() },
    proposal: (preparationId) => preparations.get(preparationId),
    async finalizeSkillPublication(preparation) {
      if (preparation.target.kind !== "skill-package") throw new Error("Only a skill package preparation can finalize package publication")
      if (preparation.action === "adopt-default") {
        await rm(join(dirname(preparation.target.path), ".base"), { recursive: true, force: true })
        await options.baselines.set(preparation.target.path, preparation.target.currentDefaultPackageIdentity)
      } else {
        await reload()
        const override = find(preparation.target.path)
        const proposed = preparation.proposed
        if (!proposed || proposed.kind !== "skill-package") throw new Error("The prepared skill result is incomplete")
        const expectedIdentity = await packageIdentity(new Map(Object.entries(proposed.files)))
        const currentTarget = await bindTarget(override)
        if (currentTarget.kind !== "skill-package" || currentTarget.overridePackageIdentity !== expectedIdentity) throw new Error("Definition override changed after package publication")
        await replaceSnapshot(override, options.catalog)
        await options.baselines.set(override.path, override.currentDefaultHash)
      }
      await reload()
    },
  }
}


async function rebaseSource(override: DefinitionOverride, catalog: BundledDefaultCatalog): Promise<OverrideRebaseSource> {
  const theirs = currentContent(override, catalog)
  const mine = await overrideContent(override)
  if (!override.snapshotAvailable) return { kind: "missing-base", theirs, mine, mineVersusTheirs: diffForContents(override, theirs, mine), reason: "The fork snapshot is missing, so a verified three-way rebase is unavailable. Compare mine with theirs and provide the complete result." }
  const base = await snapshotContent(override)
  if (!await snapshotMatchesDeclaredBase(override, base)) {
    return { kind: "missing-base", theirs, mine, mineVersusTheirs: diffForContents(override, theirs, mine), reason: "The fork snapshot does not match the acknowledged baseline, so a verified three-way rebase is unavailable. Compare mine with theirs and provide the complete result." }
  }
  return { kind: "verified-three-way", base, theirs, mine }
}

function currentContent(override: DefinitionOverride, catalog: BundledDefaultCatalog): CompleteOverrideContent {
  if (override.family !== "skill") return { kind: "single-file", content: catalog.files[override.catalogPath]?.content ?? "" }
  const prefix = skillCatalogPrefix(override)
  return { kind: "skill-package", files: sortedRecord(Object.entries(catalog.files).filter(([path]) => path.startsWith(prefix)).map(([path, file]) => [path.slice(prefix.length), file.content])) }
}

async function overrideContent(override: DefinitionOverride): Promise<CompleteOverrideContent> {
  if (override.family !== "skill") return { kind: "single-file", content: await readFile(override.path, "utf8") }
  return { kind: "skill-package", files: sortedRecord(await packageFiles(dirname(override.path), true)) }
}

async function snapshotContent(override: DefinitionOverride): Promise<CompleteOverrideContent> {
  if (override.family !== "skill") return { kind: "single-file", content: await readFile(override.snapshotPath, "utf8") }
  return { kind: "skill-package", files: sortedRecord(await packageFiles(override.snapshotPath, false)) }
}

async function snapshotMatchesDeclaredBase(override: DefinitionOverride, base: CompleteOverrideContent): Promise<boolean> {
  if (!override.baseDefaultHash) return false
  if (base.kind === "single-file") return sha256(base.content) === override.baseDefaultHash
  return await packageIdentity(new Map(Object.entries(base.files))) === override.baseDefaultHash
}

function validateProposed(target: PreparedOverrideTarget, proposed: CompleteOverrideContent | undefined): void {
  if (!proposed) return
  if ((target.kind === "single-file") !== (proposed.kind === "single-file")) throw new Error("The proposed rebase result does not match the override kind")
  if (proposed.kind === "skill-package" && proposed.files["SKILL.md"] === undefined) throw new Error("A complete skill package must include SKILL.md")
}

function validateCompletePackage(content: CompleteOverrideContent | undefined): void {
  if (content?.kind !== "skill-package") return
  if (content.files["SKILL.md"] === undefined) throw new Error("A complete skill package must include SKILL.md")
  for (const path of Object.keys(content.files)) {
    const refusal = packagePathRefusal(path)
    if (refusal) throw new Error(refusal)
  }
}

function diffForContents(override: DefinitionOverride, before: CompleteOverrideContent, after: CompleteOverrideContent): MutationDiff {
  if (before.kind !== after.kind) throw new Error("Override content kinds do not match")
  if (before.kind === "single-file" && after.kind === "single-file") return buildMutationDiff([{ path: override.path, before: { kind: "text", text: before.content }, after: { kind: "text", text: after.content } }])
  if (before.kind !== "skill-package" || after.kind !== "skill-package") throw new Error("Override content kinds do not match")
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
  return buildMutationDiff(paths.map((path) => ({ path: `${override.id}/${path}`, before: path in before.files ? { kind: "text" as const, text: before.files[path] ?? "" } : { kind: "absent" as const }, after: path in after.files ? { kind: "text" as const, text: after.files[path] ?? "" } : { kind: "absent" as const } })))
}

/** The Markdown the person reads before approving: the action, the override it
 *  changes, and one fenced patch for each file approval changes. */
function preparationSummary(override: DefinitionOverride, action: OverrideResolutionAction, diff: MutationDiff): string {
  const lines = [actionSentence(override, action)]
  for (const file of diff.files) {
    const fence = "`".repeat(Math.max(3, longestBacktickRun(file.unifiedDiff) + 1))
    lines.push("", `\`${file.path}\` (${file.change})`, `${fence}diff`, file.unifiedDiff.trimEnd(), fence)
    if (file.omittedLines) lines.push(`${file.omittedLines} more lines are not shown.`)
  }
  for (const omission of diff.omissions) lines.push("", `\`${omission.path}\`: the patch is not shown (${omission.reason}).`)
  return lines.join("\n")
}

function actionSentence(override: DefinitionOverride, action: OverrideResolutionAction): string {
  const definition = `the ${override.family} \`${override.id}\``
  const copy = `${override.layer} override at \`${override.family === "skill" ? dirname(override.path) : override.path}\``
  switch (action) {
    case "keep-mine": return `**Keep your override** for ${definition}. Approval keeps the ${copy} unchanged and records that you reviewed the current default.`
    case "adopt-default": return `**Adopt the default** for ${definition}. Approval deletes the ${copy}, so the bundled default applies.`
    case "rebase": return `**Rebase your override** for ${definition}. Approval replaces the ${copy} with the merged result below.`
  }
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length))
}

async function writeProposed(override: DefinitionOverride, proposed: CompleteOverrideContent): Promise<void> {
  if (proposed.kind === "single-file") {
    await writeFileAtomic(override.path, proposed.content)
    return
  }
  const root = dirname(override.path)
  const existing = await packageFiles(root, true)
  for (const path of existing.keys()) if (!(path in proposed.files)) await rm(join(root, path), { force: true })
  for (const [path, content] of Object.entries(proposed.files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFileAtomic(target, content)
  }
}

interface SortedStringEntries {
  readonly [path: string]: string
}

function sortedRecord(entries: Iterable<readonly [string, string]>): Readonly<SortedStringEntries> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)))
}

function cleanPublication(content: CompleteOverrideContent): CompleteOverrideContent {
  if (content.kind === "single-file") return content
  if (content.files["SKILL.md"] === undefined) throw new Error("A complete skill package must include SKILL.md")
  return { kind: "skill-package", files: sortedRecord(Object.entries(content.files)) }
}

async function bindTarget(override: DefinitionOverride): Promise<PreparedOverrideTarget> {
  const base = { family: override.family, id: override.id, path: override.path, layer: override.layer }
  if (override.family !== "skill") {
    const snapshotIdentity = override.snapshotAvailable ? await canonicalFileIdentity(override.snapshotPath) : undefined
    return { ...base, kind: "single-file", overrideIdentity: await canonicalFileIdentity(override.path), currentDefaultIdentity: override.currentDefaultHash, ...(snapshotIdentity ? { snapshotIdentity } : {}) }
  }
  const overridePackageIdentity = await packageIdentity(await packageFiles(dirname(override.path), true))
  const snapshotPackageIdentity = override.snapshotAvailable ? await packageIdentity(await packageFiles(override.snapshotPath, false)) : undefined
  return { ...base, kind: "skill-package", reach: override.layer === "user" ? "global" : "project", overridePackageIdentity, currentDefaultPackageIdentity: override.currentDefaultHash, ...(snapshotPackageIdentity ? { snapshotPackageIdentity } : {}) }
}

async function replaceSnapshot(override: DefinitionOverride, catalog: BundledDefaultCatalog): Promise<void> {
  await mkdir(dirname(override.snapshotPath), { recursive: true })
  if (override.family !== "skill") {
    const current = catalog.files[override.catalogPath]
    if (!current) throw new Error("Bundled default disappeared while updating its snapshot")
    await writeFileAtomic(override.snapshotPath, current.content)
    return
  }
  await rm(override.snapshotPath, { recursive: true, force: true })
  await mkdir(override.snapshotPath, { recursive: true })
  const prefix = skillCatalogPrefix(override)
  for (const [catalogPath, file] of Object.entries(catalog.files)) {
    if (!catalogPath.startsWith(prefix)) continue
    const target = join(override.snapshotPath, catalogPath.slice(prefix.length))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, "utf8")
  }
}

function skillCatalogPrefix(override: DefinitionOverride): string {
  return `${override.catalogPath.slice(0, override.catalogPath.lastIndexOf("/") + 1)}`
}

async function canonicalFileIdentity(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Definition override is not a file: ${path}`)
  return sha256(await readFile(path, "utf8"))
}

async function packageFiles(root: string, excludeSnapshot: boolean): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const visit = async (dir: string, prefix = ""): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (excludeSnapshot && !prefix && entry.name === ".base") continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (entry.isFile()) files.set(relative, await readFile(absolute, "utf8"))
      else throw new Error(`Skill package contains an unsupported entry: ${relative}`)
    }
  }
  await visit(root)
  return files
}

async function packageIdentity(files: ReadonlyMap<string, string>): Promise<string> {
  const hash = createHash("sha256")
  for (const [path, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const contentHash = sha256(content)
    hash.update(`${Buffer.byteLength(path)}:${path}${contentHash.length}:${contentHash}`)
  }
  return hash.digest("hex")
}
function targetsEqual(left: PreparedOverrideTarget, right: PreparedOverrideTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}
