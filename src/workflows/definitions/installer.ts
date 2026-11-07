import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { errorMessage } from "../../infra/error-message.js"
import { readAppVersion } from "../../infra/app-version.js"
import { configurationReferenceFile } from "../../infra/paths.js"
import { writeFileAtomic } from "../../infra/atomic-write.js"
import { Log } from "../../infra/log.js"
import { isProcessAlive } from "../../infra/process-liveness.js"
import { workflowAssets } from "../agents/manifest.js"
import type { BundledDefaultCatalog } from "./bundled-defaults.js"

const log = Log.create({ service: "definitions-installer" })

/** Publishes this build's reference definitions and guides. Reports failures
 * without refusing runtime startup or another owned background operation. */
export async function publishBundledReferences(userDataRoot: string, catalog: BundledDefaultCatalog): Promise<void> {
  try {
    const result = await installBundledDefaults({ userDataRoot, binaryVersion: await readAppVersion(), catalog })
    for (const error of result.errors) log.warn("defaults publication failed (non-fatal)", { error })
  } catch (error) {
    log.warn("defaults publication failed (non-fatal)", { error: errorMessage(error) })
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface DefaultManifestFiles {
  [path: string]: string
}

interface DefaultsManifest {
  readonly version: 1
  readonly binaryVersion: string
  readonly files: DefaultManifestFiles
}

export interface InstallBundledDefaultsOptions {
  readonly userDataRoot: string
  readonly binaryVersion: string
  readonly catalog: BundledDefaultCatalog
}

export interface InstallBundledDefaultsResult {
  readonly installed: number
  readonly errors: string[]
}

function expectedManifest(binaryVersion: string, catalog: BundledDefaultCatalog): DefaultsManifest {
  return {
    version: 1,
    binaryVersion,
    files: Object.fromEntries(Object.entries(catalog.files).sort(([left], [right]) => left.localeCompare(right)).map(([path, file]) => [path, file.sourceHash])),
  }
}

function parseManifest(value: JsonValue): DefaultsManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const files = value.files
  if (value.version !== 1 || typeof value.binaryVersion !== "string" || typeof files !== "object" || files === null || Array.isArray(files)) return null
  if (!Object.entries(files).every(([path, hash]) => path.length > 0 && typeof hash === "string")) return null
  const parsedFiles: DefaultManifestFiles = {}
  for (const [path, hash] of Object.entries(files)) {
    if (typeof hash !== "string") return null
    parsedFiles[path] = hash
  }
  return { version: 1, binaryVersion: value.binaryVersion, files: parsedFiles }
}

function hasSameSources(left: DefaultsManifest, right: DefaultsManifest): boolean {
  return left.version === right.version && JSON.stringify(left.files) === JSON.stringify(right.files)
}

async function readManifest(path: string): Promise<DefaultsManifest | null> {
  try {
    const value: JsonValue = await Bun.file(path).json()
    return parseManifest(value)
  } catch {
    return null
  }
}


async function sweepDeadAttempts(userDataRoot: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(userDataRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    const match = /^defaults\.(?:tmp|old)\.(\d+)\.[^.]+$/.exec(entry)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || isProcessAlive(pid)) continue
    await rm(join(userDataRoot, entry), { recursive: true, force: true })
  }
}

const OVERRIDE_README_FOOTER = [
  "The bundled definitions are published for reference under `../defaults/`. That tree is machine-owned: do not edit it, it is overwritten on upgrade. Copy a file from it into an override directory and edit the copy.",
  "",
].join("\n")

interface OverrideReadmes {
  readonly [dir: string]: string
}

const OVERRIDE_DIR_READMES = {
  agents: [
    "# Agent Overrides (all projects)",
    "",
    "Files in this directory override the bundled agent personas for every project on this machine. The file name selects the persona it replaces, for example `explorer.md`.",
    "",
    "Precedence, highest first: `<project>/.flywheel/agents/`, this directory, the bundled defaults.",
    "",
    OVERRIDE_README_FOOTER,
  ].join("\n"),
  skills: [
    "# Skill Packages (all projects)",
    "",
    "Skill packages in this directory install for every project on this machine. A package is a directory that holds a `SKILL.md` file, for example `my-skill/SKILL.md`. A package directory with the same name as a bundled package replaces it.",
    "",
    "Precedence, highest first: `<project>/.flywheel/skills/`, this directory, `~/.agents/skills/`, the bundled defaults.",
    "",
    OVERRIDE_README_FOOTER,
  ].join("\n"),
} satisfies OverrideReadmes

// Installer texts from 4e579573d9 and 0e90bd62ad. Remove after 2027-04-30.
const RETIRED_WORKFLOW_READMES = ["", "A workflow here runs a brief from the `briefs/` folder in this directory before a bundled brief of the same name. To change a bundled brief, copy it from `../defaults/workflows/briefs/` into `briefs/` and edit the copy.\n\n"].map((briefs) => Buffer.from([
  "# Workflow Overrides (all projects)",
  "",
  "Workflow definitions in this directory override the bundled workflows for every project on this machine. The `id` field inside the `.yaml` file selects the workflow it replaces.",
  "",
  `${briefs}Precedence, highest first: \`<project>/.flywheel/workflows/\`, this directory, the bundled defaults.`,
  "",
  OVERRIDE_README_FOOTER,
].join("\n")))

/** Matches only byte-exact workflow README files written by the retired installer. Remove after 2027-04-30. */
export function isRetiredWorkflowReadme(bytes: Uint8Array): boolean {
  return RETIRED_WORKFLOW_READMES.some((readme) => readme.equals(bytes))
}

/** Removes only the old installer README and its empty folder. User files stay unchanged. Remove after 2027-04-30. */
async function removeRetiredWorkflowReadme(userDataRoot: string): Promise<void> {
  const dir = join(userDataRoot, "workflows")
  const path = join(dir, "README.md")
  try {
    if (!isRetiredWorkflowReadme(await readFile(path))) return
    await unlink(path)
    try { await rmdir(dir) }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) return
      throw error
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    log.warn("retired workflow README cleanup failed", { dir, error: errorMessage(error) })
  }
}

/** Creates the user override directories so it is discoverable where overrides
 * go, with a README in each that names the layout and precedence. The README
 * is created exclusively (`wx`): one already present, whatever its content,
 * is never overwritten. Each directory is independent, so one damaged path
 * does not suppress the others. */
async function ensureUserOverrideDirs(userDataRoot: string): Promise<void> {
  for (const [dir, readme] of Object.entries(OVERRIDE_DIR_READMES)) {
    const target = join(userDataRoot, dir)
    try {
      await mkdir(target, { recursive: true })
      await writeFile(join(target, "README.md"), readme, { flag: "wx" })
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue
      log.warn("override directory creation failed (non-fatal)", { dir: target, error: errorMessage(error) })
    }
  }
}

/** User-facing guides published machine-owned at the user data root, next to
 * `flywheel.toml`, so the user who opens the directory to edit config finds
 * them. Each entry maps its canonical install target to a workflow-asset path
 * under `src/workflows/`, which the binary build embeds in the manifest. */
const USER_GUIDE_SOURCES = [
  { target: (userDataRoot: string): string => join(userDataRoot, "custom-providers.md"), source: "docs/custom-providers.md" },
  { target: configurationReferenceFile, source: "docs/configuration.md" },
  { target: (userDataRoot: string): string => join(userDataRoot, "cli.md"), source: "docs/cli.md" },
  { target: (userDataRoot: string): string => join(userDataRoot, "commands.md"), source: "docs/commands.md" },
  { target: (userDataRoot: string): string => join(userDataRoot, "keys.md"), source: "docs/keys.md" },
] as const

async function userGuideContent(assetPath: string): Promise<Uint8Array> {
  const bundled = workflowAssets[assetPath]
  if (bundled !== undefined) return new TextEncoder().encode(bundled)
  return Bun.file(join(fileURLToPath(new URL("..", import.meta.url)), assetPath)).bytes()
}

/** Publishes the bundled user guides at the user data root. Machine-owned like
 * the defaults tree: a missing or edited copy is rewritten so an upgrade keeps
 * it current. Each guide is independent and a failure is non-fatal. */
async function publishUserGuides(userDataRoot: string): Promise<void> {
  for (const guide of USER_GUIDE_SOURCES) {
    const target = guide.target(userDataRoot)
    try {
      const content = await userGuideContent(guide.source)
      const current = await Bun.file(target).bytes().catch(() => null)
      if (current !== null && Buffer.from(current).equals(content)) continue
      writeFileAtomic(target, new TextDecoder("utf-8", { fatal: true }).decode(content))
    } catch (error) {
      log.warn("user guide publication failed (non-fatal)", { file: target, error: errorMessage(error) })
    }
  }
}

/** Matches only the retired persona installer's manifest: exactly its historical
 * keys, a sha256 tree hash, and flat markdown persona names. A looser shape could
 * be some other tool's file and must never authorize deletion. */
function legacyAgentManifestFiles(manifest: JsonValue): readonly string[] | null {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return null
  if (Object.keys(manifest).sort().join(",") !== "files,sourceHash,version") return null
  if (manifest.version !== 1) return null
  const sourceHash = manifest.sourceHash
  if (typeof sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(sourceHash)) return null
  const files = manifest.files
  if (!Array.isArray(files)) return null
  return files.filter((file): file is string => typeof file === "string").length === files.length && files.every((file) => typeof file === "string" && /^[\w.-]+(?:\/[\w.-]+)*\.md$/.test(file) && !file.split("/").includes("..")) ? files.filter((file): file is string => typeof file === "string") : null
}

/** Before defaults/ existed, personas were machine-installed into the top-level
 * agents/ dir under an rm-rf-on-upgrade contract, marked by this manifest. Those
 * leftovers would now shadow defaults/agents/ as phantom user overrides, so the
 * files the legacy manifest lists are removed once. User files it does not list stay. */
export async function removeLegacyAgentInstall(userDataRoot: string): Promise<void> {
  const agentsDir = join(userDataRoot, "agents")
  const manifestPath = join(agentsDir, ".manifest.json")
  let manifest: JsonValue
  try {
    manifest = await Bun.file(manifestPath).json()
  } catch {
    return
  }
  const files = legacyAgentManifestFiles(manifest)
  if (!files) return
  for (const file of files) {
    await rm(join(agentsDir, file), { force: true })
  }
  await rm(manifestPath, { force: true })
  try {
    await rmdir(agentsDir)
  } catch {
    // The dir holds user files the legacy manifest did not list; keep it.
  }
  log.info("removed legacy machine-installed personas from agents/", { files: files.length })
}

async function warnForDrift(defaultsDir: string, manifest: DefaultsManifest | null, catalog: BundledDefaultCatalog): Promise<void> {
  if (!manifest) return
  for (const path of Object.keys(manifest.files)) {
    const file = catalog.files[path]
    if (!file) continue
    try {
      const content = await Bun.file(join(defaultsDir, path)).text()
      if (content !== file.content) {
        log.warn("machine-owned default was edited; overwriting", { file: path, overlayTarget: file.overlayTarget })
      }
    } catch {
      log.warn("machine-owned default was edited; overwriting", { file: path, overlayTarget: file.overlayTarget })
    }
  }
}

async function stageTree(stageDir: string, catalog: BundledDefaultCatalog, manifest: DefaultsManifest): Promise<number> {
  await mkdir(stageDir, { recursive: false })
  let installed = 0
  for (const [path, file] of Object.entries(catalog.files).sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(stageDir, path)
    await mkdir(dirname(target), { recursive: true })
    await Bun.write(target, file.content)
    installed++
  }
  await Bun.write(join(stageDir, ".manifest.json"), JSON.stringify(manifest))
  return installed
}

async function publishStage(defaultsDir: string, stageDir: string, priorDir: string, expected: DefaultsManifest): Promise<"published" | "winner" | "retry"> {
  let ownsPrior = false
  try {
    try {
      await rename(defaultsDir, priorDir)
      ownsPrior = true
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error
    }
    try {
      await rename(stageDir, defaultsDir)
      if (ownsPrior) await rm(priorDir, { recursive: true, force: true })
      return "published"
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
      // Windows has no atomic directory replace: renaming a staged folder onto a name a
      // competitor already published reports EPERM where POSIX reports EEXIST or
      // ENOTEMPTY. The winner's manifest read below is what separates that race
      // from a real permission failure, which still surfaces.
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error
      const winner = await readManifest(join(defaultsDir, ".manifest.json"))
      if (!winner) throw new Error("a competing defaults publication did not publish a complete manifest", { cause: error })
      if (ownsPrior) await rm(priorDir, { recursive: true, force: true })
      await rm(stageDir, { recursive: true, force: true })
      return hasSameSources(winner, expected) ? "winner" : "retry"
    }
  } catch (error) {
    if (ownsPrior) {
      const winner = await readManifest(join(defaultsDir, ".manifest.json"))
      if (winner) {
        await rm(priorDir, { recursive: true, force: true })
      } else {
        try {
          await rename(priorDir, defaultsDir)
        } catch {
          // Another invocation owns the path. The dead-owner sweep retains this attempt's recovery tree until its owner exits.
        }
      }
    }
    throw error
  }
}

/** Publishes the binary-owned reference definitions under `userDataRoot/defaults`.
 * Loading does not read this tree. Failures are returned so startup can continue. */
export async function installBundledDefaults(options: InstallBundledDefaultsOptions): Promise<InstallBundledDefaultsResult> {
  const { catalog } = options
  const manifest = expectedManifest(options.binaryVersion, catalog)
  const defaultsDir = join(options.userDataRoot, "defaults")
  const manifestPath = join(defaultsDir, ".manifest.json")
  try {
    await removeLegacyAgentInstall(options.userDataRoot)
  } catch (error) {
    log.warn("legacy persona cleanup failed", { error: errorMessage(error) })
  }
  await ensureUserOverrideDirs(options.userDataRoot)
  await removeRetiredWorkflowReadme(options.userDataRoot)
  await publishUserGuides(options.userDataRoot)
  const current = await readManifest(manifestPath)
  if (current && hasSameSources(current, manifest)) return { installed: 0, errors: [] }

  try {
    await mkdir(options.userDataRoot, { recursive: true })
    await sweepDeadAttempts(options.userDataRoot)
    await warnForDrift(defaultsDir, current, catalog)
    for (let attempt = 0; attempt < 5; attempt++) {
      const attemptId = `${process.pid}.${randomUUID()}`
      const stageDir = join(options.userDataRoot, `defaults.tmp.${attemptId}`)
      const priorDir = join(options.userDataRoot, `defaults.old.${attemptId}`)
      let staged = false
      try {
        const installed = await stageTree(stageDir, catalog, manifest)
        staged = true
        const publication = await publishStage(defaultsDir, stageDir, priorDir, manifest)
        staged = false
        if (publication !== "retry") return { installed, errors: [] }
      } finally {
        if (staged) await rm(stageDir, { recursive: true, force: true })
      }
    }
    throw new Error("defaults publication contention did not settle")
  } catch (error) {
    return { installed: 0, errors: [errorMessage(error)] }
  }
}
