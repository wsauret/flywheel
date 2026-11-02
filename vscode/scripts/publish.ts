/** Publishes the one universal VSIX for the current extension version.
 *
 * The package installs Flywheel through the latest public release on a
 * machine that has none, so it must speak that release's protocol. Before
 * anything is uploaded, `scripts/e2e-bootstrap.ts` installs the latest release
 * into a bare account home and attaches to it; a package whose release is not
 * public yet fails there.
 *
 * Usage:
 *   bun run publish:marketplace --dry-run
 *   bun run publish:marketplace
 *   bun run publish:marketplace --recover-tag
 */

import { existsSync, lstatSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { previousReleaseTag } from "../../scripts/commit-contract.js"
import { releaseNotesManifestViolation } from "../../scripts/release-notes-manifest.js"

const ROOT = resolve(import.meta.dir, "..")
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export interface ExtensionIdentity {
  readonly name: string
  readonly publisher: string
  readonly version: string
}

function fail(reason: string): never {
  console.error(`marketplace publish: ${reason}`)
  process.exit(1)
}

export function publicationMode(arguments_: readonly string[], nodeEnvironment: string | undefined): "dry-run" | "publish" | "recover-tag" {
  const allowed = new Set(["--dry-run", "--recover-tag"])
  const unknown = arguments_.filter((argument) => !allowed.has(argument))
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(", ")}`)
  if (arguments_.length > 1) throw new Error("state only one publication mode")
  if (arguments_.includes("--dry-run")) return "dry-run"
  if (arguments_.includes("--recover-tag")) return "recover-tag"
  if (nodeEnvironment === "test") throw new Error("publication is disabled in the test environment")
  return "publish"
}

export function parseExtensionIdentity(value: unknown): ExtensionIdentity {
  if (typeof value !== "object" || value === null) throw new Error("package.json does not contain extension identity")
  if (!("name" in value) || typeof value.name !== "string") throw new Error("package.json does not contain a name")
  if (!("publisher" in value) || typeof value.publisher !== "string") throw new Error("package.json does not contain a publisher")
  if (!("version" in value) || typeof value.version !== "string" || !STRICT_SEMVER.test(value.version)) {
    throw new Error("package.json version must be strict semantic versioning")
  }
  return { name: value.name, publisher: value.publisher, version: value.version }
}

export function expectedArchive(version: string): string {
  return `flywheel-${version}.vsix`
}

export function extensionReleaseTag(version: string): string {
  return `vscode-v${version}`
}

export function marketplacePublishCommand(notes: string, archive: string): string[] {
  return ["bunx", "@vscode/vsce", "publish", "--changelog-path", notes, "--packagePath", archive]
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface MarketplacePublicationDependencies {
  readonly marketplace: (command: readonly string[]) => CommandResult;
  readonly git: (arguments_: readonly string[]) => CommandResult;
}

/** Stage the local boundary before the irreversible upload. A failed upload
 * removes it; a failed push leaves it as the recovery handle. */
export function publishMarketplaceAndTag(
  command: readonly string[],
  tag: string,
  dependencies: MarketplacePublicationDependencies,
): string | undefined {
  const created = dependencies.git(["tag", tag]);
  if (created.exitCode !== 0) return `${tag} could not be created before publication: ${created.stderr}`;
  const published = dependencies.marketplace(command);
  if (published.exitCode !== 0) {
    const cleanup = dependencies.git(["tag", "-d", tag]);
    const cleanupFailure = cleanup.exitCode === 0 ? "" : `; ${tag} could not be removed: ${cleanup.stderr}`;
    return `Marketplace publication failed: ${published.stderr}${cleanupFailure}`;
  }
  const pushed = dependencies.git(["push", "origin", tag]);
  if (pushed.exitCode !== 0) return `Marketplace published, but ${tag} could not be pushed: ${pushed.stderr}. Run bun run publish:marketplace --recover-tag`;
  return undefined;
}

export function marketplaceVersionPublished(output: string, version: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || !("versions" in value) || !Array.isArray(value.versions)) return false;
  return value.versions.some((candidate) => typeof candidate === "object" && candidate !== null && "version" in candidate && candidate.version === version);
}

export function recoverMarketplaceTag(
  identity: ExtensionIdentity,
  tag: string,
  dependencies: MarketplacePublicationDependencies,
): string | undefined {
  const tagCommit = dependencies.git(["rev-parse", `${tag}^{commit}`]);
  if (tagCommit.exitCode !== 0) return `${tag} does not exist locally; there is no publication boundary to recover`;
  const head = dependencies.git(["rev-parse", "HEAD"]);
  if (head.exitCode !== 0 || tagCommit.stdout !== head.stdout) return `${tag} does not name the current source commit`;
  const shown = dependencies.marketplace(["bunx", "@vscode/vsce", "show", `${identity.publisher}.${identity.name}`, "--json"]);
  if (shown.exitCode !== 0) return `the Marketplace release could not be verified: ${shown.stderr}`;
  if (!marketplaceVersionPublished(shown.stdout, identity.version)) return `Marketplace version ${identity.version} is not published; delete ${tag} and publish again`;
  const pushed = dependencies.git(["push", "origin", tag]);
  return pushed.exitCode === 0 ? undefined : `${tag} could not be pushed: ${pushed.stderr}`;
}

function xmlAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
}

/** The packaged identity. `target` is the platform a platform-specific
 *  package names, and is absent from a universal one. */
export function parseVsixIdentity(manifest: string): (ExtensionIdentity & { target: string | undefined }) | undefined {
  const tag = manifest.match(/<Identity\b[^>]*\/>/)?.[0]
  if (tag === undefined) return undefined
  const name = xmlAttribute(tag, "Id")
  const publisher = xmlAttribute(tag, "Publisher")
  const version = xmlAttribute(tag, "Version")
  return name === undefined || publisher === undefined || version === undefined
    ? undefined
    : { name, publisher, version, target: xmlAttribute(tag, "TargetPlatform") }
}

function validateArchive(identity: ExtensionIdentity, filename: string): void {
  const path = resolve(ROOT, filename)
  if (dirname(path) !== ROOT || !existsSync(path) || !lstatSync(path).isFile()) {
    fail(`${filename} is not a regular release artifact. Run bun run package first.`)
  }

  const inspection = Bun.spawnSync(["unzip", "-p", path, "extension.vsixmanifest"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  if (inspection.exitCode !== 0) fail(`${filename} is not a readable VSIX: ${inspection.stderr.toString().trim()}`)

  const actual = parseVsixIdentity(inspection.stdout.toString())
  if (actual === undefined || actual.name !== identity.name || actual.publisher !== identity.publisher || actual.version !== identity.version || actual.target !== undefined) {
    fail(`${filename} does not contain the expected universal ${identity.publisher}.${identity.name} ${identity.version} manifest`)
  }
}

function git(arguments_: readonly string[]): CommandResult {
  const result = Bun.spawnSync(["git", ...arguments_], { cwd: ROOT, stdout: "pipe", stderr: "pipe", windowsHide: true })
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() }
}

function marketplace(command: readonly string[], inheritOutput = false): CommandResult {
  const result = Bun.spawnSync([...command], {
    cwd: ROOT,
    stdout: inheritOutput ? "inherit" : "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout?.toString().trim() ?? "",
    stderr: result.stderr.toString().trim(),
  }
}

function recoverTag(identity: ExtensionIdentity, tag: string): void {
  const failure = recoverMarketplaceTag(identity, tag, { git, marketplace });
  if (failure !== undefined) fail(failure);
  console.log(`marketplace publish: recovered and pushed ${tag}`)
}

async function main(): Promise<void> {
  let mode: "dry-run" | "publish" | "recover-tag"
  try {
    mode = publicationMode(process.argv.slice(2), process.env.NODE_ENV)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  let identity: ExtensionIdentity
  try {
    identity = parseExtensionIdentity(await Bun.file(join(ROOT, "package.json")).json())
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const tag = extensionReleaseTag(identity.version)
  if (mode === "recover-tag") {
    recoverTag(identity, tag)
    return
  }

  const archive = expectedArchive(identity.version)
  validateArchive(identity, archive)

  const notes = resolve(ROOT, "dist", "release-notes.md")
  const notesManifest = resolve(ROOT, "dist", "release-notes.json")
  if (!existsSync(notes) || !lstatSync(notes).isFile()) fail("dist/release-notes.md is missing. Run bun run notes:draft first.")
  if (!existsSync(notesManifest) || !lstatSync(notesManifest).isFile()) fail("dist/release-notes.json is missing. Run bun run notes:draft first.")
  const notesText = await Bun.file(notes).text()
  const manifestValue: unknown = await Bun.file(notesManifest).json()
  const head = git(["rev-parse", "HEAD"])
  if (head.exitCode !== 0) fail(`the source commit could not be read: ${head.stderr}`)
  const violation = releaseNotesManifestViolation(
    manifestValue,
    { surface: "vscode", releaseVersion: identity.version, head: head.stdout, baseTag: previousReleaseTag(identity.version, "vscode") },
    notesText,
  )
  if (violation !== undefined) fail(violation)

  // The package installs whatever release is public as `latest`, so that
  // release must install, listen, and accept this build's attach.
  const bootstrap = Bun.spawnSync(["bun", "run", "scripts/e2e-bootstrap.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true })
  if (bootstrap.exitCode !== 0) fail("the latest public release does not install and serve this build; publish the runtime release it needs first")

  const command = marketplacePublishCommand(notes, archive)
  if (mode === "dry-run") {
    console.log(`marketplace publish: ready to publish ${archive} for version ${identity.version}`)
    console.log(`marketplace publish: ${tag} will mark the published source commit`)
    console.log(`  ${command.join(" ")}`)
    return
  }

  const dirty = git(["status", "--porcelain"])
  if (dirty.exitCode !== 0) fail(`the worktree could not be read: ${dirty.stderr}`)
  if (dirty.stdout !== "") fail("the worktree is not clean; commit the version and source before publishing")
  const localTag = git(["tag", "--list", tag])
  if (localTag.exitCode !== 0) fail(`local tags could not be read: ${localTag.stderr}`)
  if (localTag.stdout !== "") fail(`${tag} already exists locally`)
  const remoteTag = git(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])
  if (remoteTag.exitCode === 0) fail(`${tag} already exists on origin`)
  if (remoteTag.exitCode !== 2) fail(`origin tags could not be read: ${remoteTag.stderr}`)

  console.log(`marketplace publish: publishing ${archive} for version ${identity.version}`)
  const publicationFailure = publishMarketplaceAndTag(command, tag, {
    marketplace: (publishCommand) => marketplace(publishCommand, true),
    git,
  })
  if (publicationFailure !== undefined) fail(publicationFailure)
  console.log(`marketplace publish: published ${identity.version} and pushed ${tag}`)
}

if (import.meta.main) await main()
