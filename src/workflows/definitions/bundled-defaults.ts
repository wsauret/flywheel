import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { systemPromptText } from "../../infra/agent-assets/manifest.js"
import { agents, moduleSkillDefinitions, skillDefinitions, type WorkflowAssets } from "../agents/manifest.js"
import { definitionAssets } from "../definition-assets.js"
import { loadAgentDefaults } from "../agents/installer.js"
import { BUNDLED_SKILL_DIR } from "../skill-source-inventory.js"
import type { DefinitionBundle } from "../loader.js"


interface BundledDefaultFile {
  readonly content: string
  readonly overlayTarget: string
  readonly sourceHash: string
  readonly baseDefaultHash: string
}

interface BundledDefaultFiles {
  readonly [path: string]: BundledDefaultFile
}

interface MutableTextFiles {
  [path: string]: string
}

interface MutableBundledDefaultFiles {
  [path: string]: BundledDefaultFile
}

export interface BundledDefaultCatalog {
  readonly files: BundledDefaultFiles
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function readFilesRecursive(dir: string): MutableTextFiles {
  const files: MutableTextFiles = {}
  const visit = (current: string, prefix = ""): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) visit(absolute, relativePath)
      else if (entry.isFile()) files[relativePath] = readFileSync(absolute, "utf8")
    }
  }
  visit(dir)
  return files
}

function sourceSkillFiles(dir: string): MutableTextFiles {
  if (!existsSync(dir)) return {}
  return Object.fromEntries(
    Object.entries(readFilesRecursive(dir)).filter(([path]) => !path.startsWith("references/")),
  )
}

/** One shipped bundle's packages: its source tree when present, as the loader
 *  reads it, else the compiled manifest. */
function bundleSkillFiles({ id, root }: DefinitionBundle): WorkflowAssets {
  const dir = join(root, "skills")
  return existsSync(dir) ? sourceSkillFiles(dir) : moduleSkillDefinitions[id] ?? {}
}

function packageIdentity(packageFiles: readonly (readonly [string, string])[]): string {
  const hash = createHash("sha256")
  for (const [path, content] of packageFiles) {
    const pathBytes = Buffer.byteLength(path)
    const contentHash = sha256(content)
    hash.update(`${pathBytes}:`)
    hash.update(path)
    hash.update(`${contentHash.length}:`)
    hash.update(contentHash)
  }
  return hash.digest("hex")
}


function addFile(
  files: MutableBundledDefaultFiles,
  target: string,
  overlayTarget: string,
  content: string,
  baseDefaultHash?: string,
): void {
  files[target] = { content, overlayTarget, sourceHash: sha256(content), baseDefaultHash: baseDefaultHash ?? sha256(content) }
}

/** Returns every binary-owned definition from the compiled manifests, with the
 * source tree as the dev-mode fallback. The returned paths are reference-only
 * targets and are not loader roots. `bundles` are the module definition
 * bundles that the release ships: their skill packages sit at the same
 * `skills/<id>/` paths as Flywheel's own, so an override of one still diffs
 * and rebases. A bundle that only a source run loads is never a default. */
export function loadBundledDefaultCatalog(bundles: readonly DefinitionBundle[]): BundledDefaultCatalog {
  const files: MutableBundledDefaultFiles = {}
  const prompt = systemPromptText || readFileSync(join(fileURLToPath(new URL("../../infra/agent-assets", import.meta.url)), "system-prompt.md"), "utf8")
  addFile(files, "system-prompt.md", "system-prompt.md", prompt)

  // File workflows can still refer to the core contracts until brief lookup retires.
  for (const path of definitionAssets.listCoreFiles()) {
    const content = definitionAssets.read({ root: { kind: "core" }, path })
    addFile(files, `workflows/${path}`, `workflows/${path}`, content)
  }

  const personas = Object.keys(agents).length > 0 ? agents : loadAgentDefaults()
  for (const [path, content] of Object.entries(personas).sort(([left], [right]) => left.localeCompare(right))) {
    addFile(files, `agents/${path}`, `agents/${path}`, content)
  }

  const skills = [
    ...Object.entries(Object.keys(skillDefinitions).length > 0 ? skillDefinitions : sourceSkillFiles(BUNDLED_SKILL_DIR)),
    ...bundles.flatMap((bundle) => Object.entries(bundleSkillFiles(bundle))),
  ]
  const packages = new Map<string, [string, string][]>()
  for (const [path, content] of skills) {
    const separator = path.indexOf("/")
    if (separator < 1) continue
    const packageName = path.slice(0, separator)
    const packagePath = path.slice(separator + 1)
    if (packagePath === ".base" || packagePath.startsWith(".base/")) continue
    const packageFiles = packages.get(packageName) ?? []
    packageFiles.push([packagePath, content])
    packages.set(packageName, packageFiles)
  }
  for (const [packageName, packageFiles] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
    packageFiles.sort(([left], [right]) => left.localeCompare(right))
    const identity = packageIdentity(packageFiles)
    for (const [path, content] of packageFiles) {
      addFile(files, `skills/${packageName}/${path}`, `skills/${packageName}/${path}`, content, path === "SKILL.md" ? identity : undefined)
    }
  }

  return { files }
}
