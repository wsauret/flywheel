import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import type { ScenarioContext, ScenarioResult } from "../scenarios/scenario-context.js"

const DriverManifest = Schema.Struct({
  sourceRevision: Schema.NonEmptyString,
  sourceRoot: Schema.NonEmptyString,
  entrypoint: Schema.NonEmptyString,
  driverSha256: Schema.NonEmptyString,
  archiveSha256: Schema.NonEmptyString,
  archivePath: Schema.NonEmptyString,
  releaseTag: Schema.optional(Schema.NonEmptyString),
  files: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString, sha256: Schema.NonEmptyString })),
})

/** Validates the pinned measurement source, archive, and every declared driver dependency. */
export function readRevisionDriver(manifestPath: string, releaseTag?: string) {
  const manifest = Schema.decodeUnknownSync(DriverManifest)(JSON.parse(readFileSync(manifestPath, "utf8")))
  if (releaseTag === undefined) {
    if (manifest.sourceRevision !== "01612ddbd517c1dc76eea1797ad1f07f06a5ef99") throw new Error("baseline driver requires the pinned pre-D revision")
  } else if (manifest.releaseTag !== releaseTag) throw new Error("published driver does not match the measured release tag")
  if (createHash("sha256").update(readFileSync(manifest.archivePath)).digest("hex") !== manifest.archiveSha256) throw new Error("baseline archive hash changed")
  if (createHash("sha256").update(readFileSync(manifest.entrypoint)).digest("hex") !== manifest.driverSha256) throw new Error("revision-matched driver hash changed")
  for (const file of manifest.files) {
    if (createHash("sha256").update(readFileSync(file.path)).digest("hex") !== file.sha256) throw new Error(`revision-matched driver dependency changed: ${file.path}`)
  }
  return manifest
}
const Result = Schema.Struct({
  metrics: Schema.Record(Schema.String, Schema.Number),
  failures: Schema.Array(Schema.String),
})

/** Old drivers address the default server by its absolute socket path.
 *  Give each invocation a short private directory, independent of the work
 *  root and any enclosing TMUX server. Remove this when no pinned driver
 *  predates private servers. psmux on Windows needs neither variable. */
function pinnedDriverEnvironment(cleanup: DisposableStack): NodeJS.ProcessEnv {
  if (process.platform === "win32") return process.env
  const temporaryRoot = tmpdir()
  const socket = join(temporaryRoot, "fwdrv-XXXXXX", `tmux-${process.getuid!()}`, "default")
  // oxlint-disable-next-line flywheel/no-tmp-literal-path -- boundary: old tmux clients require an absolute socket path below 104 bytes.
  const root = Buffer.byteLength(socket) < 104 ? temporaryRoot : "/tmp"
  const directory = mkdtempSync(join(root, "fwdrv-"))
  cleanup.defer(() => rmSync(directory, { recursive: true }))
  const { TMUX: _enclosing, ...inherited } = process.env
  return { ...inherited, TMUX_TMPDIR: directory }
}

/** Runs a revision-matched old client in its own Bun process. An absent or changed driver is unavailable evidence, never a candidate-client fallback.
 * perf-gate caches the published driver from its release tag. The optional pre-D comparison uses a manifest generated with tests/release/lib/materialize-revision-driver.ts and explicit source, archive, and output paths. */
export async function runRevisionDriver(context: ScenarioContext, scenario: string, published = false): Promise<ScenarioResult> {
  const variable = published ? "FLYWHEEL_RELEASE_PUBLISHED_DRIVER" : "FLYWHEEL_RELEASE_BASELINE_DRIVER"
  const manifestPath = process.env[variable]
  if (!manifestPath) return { metrics: {}, failures: [`revision-matched baseline driver manifest is required (${variable})`] }
  const releaseTag = published ? process.env.FLYWHEEL_RELEASE_PUBLISHED_TAG : undefined
  if (published && !releaseTag) return { metrics: {}, failures: ["published revision driver requires FLYWHEEL_RELEASE_PUBLISHED_TAG"] }
  const manifest = readRevisionDriver(manifestPath, releaseTag)
  writeFileSync(join(context.evidenceDir, "driver-identity.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  const input = join(context.evidenceDir, "driver-input.json")
  const output = join(context.evidenceDir, "driver-result.json")
  const { timeline: _timeline, ...serializable } = context
  writeFileSync(input, JSON.stringify({ scenario, context: serializable, output }))
  using cleanup = new DisposableStack()
  const child = Bun.spawn([process.execPath, "--conditions=browser", manifest.entrypoint, input], {
    cwd: manifest.sourceRoot, env: { ...pinnedDriverEnvironment(cleanup), ...context.environment },
    stdin: "ignore", stdout: "inherit", stderr: "inherit", windowsHide: true,
  })
  const code = await child.exited
  if (code !== 0) return { metrics: {}, failures: [`revision-matched driver exited ${code}`] }
  const result = Schema.decodeUnknownSync(Result)(JSON.parse(readFileSync(output, "utf8")))
  return { metrics: result.metrics, failures: [...result.failures] }
}
