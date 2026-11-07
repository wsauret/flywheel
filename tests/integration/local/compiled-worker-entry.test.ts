/**
 * Artifact-level proof that a compiled executable starts its embedded Worker.
 *
 * The runtime Worker is a second compile entry, and Bun serves it from the
 * executable's own module mount instead of from disk. No source-mode test can
 * reach that mount: a source launch resolves the TypeScript entry through the
 * filesystem, so only a real compiled artifact proves that the specifier
 * `embeddedEntrySpecifier` builds is the one Bun resolves.
 *
 * The probe embeds one stub for each entry the shipped executable embeds,
 * under the same basenames, rather than the whole product. What is under test
 * is the mount contract, the specifier, and the shipped entry list, and none
 * of them depends on what the entries contain. The probe is built in the release's two stages -
 * bundle with code splitting, then compile from the bundle directory with
 * the release's compile flags - so this also proves `import.meta.dir` survives bundling
 * rather than freezing to the build machine's own path, and that a Worker
 * started from the mount resolves the shared and lazily imported chunks the
 * release relies on.
 *
 * A second probe compiles the real Code Mode guest entry, because its
 * dependencies carry CommonJS and inline WebAssembly that a stub cannot
 * stand in for.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { BINARY_COMPILE_FLAGS, BINARY_ENTRIES, bundledEntryName } from "../../../scripts/binary-entries.js"
import type { HostMessage } from "../../../src/orchestration/modules/code-mode/invocation-protocol.js"
import { CODE_MODE_LIMITS } from "../../../src/orchestration/modules/code-mode/limits.js"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const CLI_SUBPROCESS = join(REPO_ROOT, "src", "infra", "cli-subprocess.ts")
const [CLI_ENTRY, ...WORKER_ENTRIES] = BINARY_ENTRIES
const workerNames = WORKER_ENTRIES.map((entry) => basename(entry, ".ts"))
/** The shipped Code Mode guest entry, and one program for it to run. */
const CODE_MODE_ENTRY = BINARY_ENTRIES.find((entry) => basename(entry) === "code-mode-invocation-worker.ts")
const CODE_MODE_START: HostMessage = {
  type: "start",
  source: "const typed: number = 6 * 7; return typed",
  descriptors: [],
  limits: { maxToolCalls: 1, maxLogBytes: 1024, maxHeapDeltaBytes: CODE_MODE_LIMITS.maxHeapDeltaBytes, heapSampleMs: CODE_MODE_LIMITS.heapSampleMs },
  bash: true,
}

/** Builds an executable in the release's two stages: bundle with code
 *  splitting, then compile from the bundle directory with relative entries
 *  and the release's compile flags, which is the shape scripts/build-binary.ts uses. */
async function compileExecutable(options: {
  readonly entrypoints: readonly string[]
  readonly bundleDir: string
  readonly executable: string
  readonly conditions?: readonly string[]
}): Promise<{ readonly chunks: number }> {
  const bundled = await Bun.build({
    entrypoints: [...options.entrypoints],
    outdir: options.bundleDir,
    naming: { entry: "[name].[ext]" },
    target: "bun",
    splitting: true,
    ...(options.conditions ? { conditions: [...options.conditions] } : {}),
  })
  expect(bundled.logs).toEqual([])
  expect(bundled.success).toBe(true)
  const compile = Bun.spawn([
    "bun",
    "build",
    ...BINARY_COMPILE_FLAGS,
    ...options.entrypoints.map((entry) => `./${bundledEntryName(entry)}`),
    "--outfile",
    options.executable,
  ], {
    cwd: options.bundleDir,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [compileError, compileExit] = await Promise.all([new Response(compile.stderr).text(), compile.exited])
  if (compileExit !== 0) throw new Error(`probe compile failed (${compileExit}): ${compileError}`)
  return { chunks: bundled.outputs.filter((output) => output.kind === "chunk").length }
}

/** Runs an executable from `cwd` and returns what it reported. */
async function runExecutable(executable: string, cwd: string) {
  const probe = Bun.spawn([executable], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ])
  return { stdout: stdout.trim(), stderr, exitCode }
}

/** Stages a probe root whose every path holds a space: the specifier crosses
 *  a process boundary and a module mount, and both must carry it without
 *  requoting. */
function stageProbeRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const paths = {
    root,
    source: join(root, "source"),
    bundleDir: join(root, "bundle out"),
    unrelatedCwd: join(root, "run from here"),
    executable: join(root, process.platform === "win32" ? "probe.exe" : "probe"),
  }
  for (const dir of [paths.source, paths.bundleDir, paths.unrelatedCwd]) mkdirSync(dir, { recursive: true })
  return paths
}

/** Reports what every Worker did as this probe's only output, so a resolution
 *  failure arrives as a readable message rather than an exit code. */
function probeSource(): string {
  return [
    `import { embeddedEntrySpecifier } from ${JSON.stringify(CLI_SUBPROCESS)}`,
    ``,
    `const entries = ${JSON.stringify(WORKER_ENTRIES.map(bundledEntryName))}`,
    `const workers = entries.map((entry) => new Worker(embeddedEntrySpecifier(import.meta.dir, entry)))`,
    `const outcomes = await Promise.all(workers.map((worker) => new Promise((resolve) => {`,
    `  const timer = setTimeout(() => resolve("no message before deadline"), 10_000)`,
    `  worker.addEventListener("message", (event) => { clearTimeout(timer); resolve(String(event.data)) })`,
    `  worker.addEventListener("error", (event) => { clearTimeout(timer); resolve(\`worker error: \${event.message}\`) })`,
    `})))`,
    `process.stdout.write(outcomes.join(","))`,
    `for (const worker of workers) worker.terminate()`,
    ``,
  ].join("\n")
}

/** Starts the real Code Mode guest from the executable's mount and runs one
 *  program through the host protocol, resets the guest, and runs the program
 *  again on the same Worker. The guest is the one Worker entry whose
 *  dependencies carry CommonJS and inline WebAssembly (the TypeScript
 *  stripper), so only the real entry proves those load from the mount. */
function codeModeProbeSource(entry: string): string {
  return [
    `import { embeddedEntrySpecifier } from ${JSON.stringify(CLI_SUBPROCESS)}`,
    ``,
    `const worker = new Worker(embeddedEntrySpecifier(import.meta.dir, ${JSON.stringify(bundledEntryName(entry))}))`,
    `const outcome = await new Promise((resolve) => {`,
    `  const timer = setTimeout(() => resolve("no result before deadline"), 20_000)`,
    `  const seen = []`,
    `  worker.addEventListener("message", (event) => {`,
    `    if (event.data.type === "ready") {`,
    `      seen.push("ready")`,
    `      return worker.postMessage(${JSON.stringify(CODE_MODE_START)})`,
    `    }`,
    `    if (event.data.type !== "result") return`,
    `    seen.push(\`\${event.data.outcome}: \${event.data.text}\`)`,
    `    if (seen.length === 1) return worker.postMessage({ type: "reset" })`,
    `    clearTimeout(timer)`,
    `    resolve(seen.join(", "))`,
    `  })`,
    `  worker.addEventListener("error", (event) => { clearTimeout(timer); resolve(\`worker error: \${event.message}\`) })`,
    `  worker.postMessage(${JSON.stringify(CODE_MODE_START)})`,
    `})`,
    `process.stdout.write(String(outcome))`,
    `worker.terminate()`,
    ``,
  ].join("\n")
}

describe("compiled executable worker entry", () => {
  test("starts the embedded Worker from an unrelated working directory", async () => {
    const probe = stageProbeRoot("flywheel compiled worker ")
    try {
      writeFileSync(join(probe.source, basename(CLI_ENTRY)), probeSource())
      // A module every entry imports becomes a shared chunk; a module only one
      // Worker imports lazily becomes a chunk loaded on demand from the mount.
      writeFileSync(join(probe.source, "alive.ts"), `export const alive = (name: string) => \`\${name}-alive\`\n`)
      writeFileSync(join(probe.source, "lazy.ts"), `export const lazily = (report: string) => report\n`)
      for (const [index, name] of workerNames.entries()) {
        writeFileSync(join(probe.source, `${name}.ts`), index === 0
          ? `import { alive } from "./alive.ts"\nconst { lazily } = await import("./lazy.ts")\nself.postMessage(lazily(alive(${JSON.stringify(name)})))\n`
          : `import { alive } from "./alive.ts"\nself.postMessage(alive(${JSON.stringify(name)}))\n`)
      }

      const { chunks } = await compileExecutable({
        entrypoints: BINARY_ENTRIES.map((entry) => join(probe.source, basename(entry))),
        bundleDir: probe.bundleDir,
        executable: probe.executable,
      })
      expect(chunks).toBeGreaterThan(0)

      expect(await runExecutable(probe.executable, probe.unrelatedCwd)).toEqual({ stdout: workerNames.map((name) => `${name}-alive`).join(","), stderr: "", exitCode: 0 })
    } finally {
      rmSync(probe.root, { recursive: true, force: true })
    }
  }, 120_000)

  test("runs the real Code Mode guest from the executable's mount", async () => {
    if (CODE_MODE_ENTRY === undefined) throw new Error("the shipped entry list no longer names the Code Mode guest")
    const probe = stageProbeRoot("flywheel compiled code mode ")
    try {
      writeFileSync(join(probe.source, basename(CLI_ENTRY)), codeModeProbeSource(CODE_MODE_ENTRY))
      await compileExecutable({
        entrypoints: [join(probe.source, basename(CLI_ENTRY)), join(REPO_ROOT, CODE_MODE_ENTRY)],
        bundleDir: probe.bundleDir,
        executable: probe.executable,
        // The release bundle resolves packages under the browser condition.
        conditions: ["browser"],
      })
      expect(await runExecutable(probe.executable, probe.unrelatedCwd)).toEqual({ stdout: "ok: 42, ready, ok: 42", stderr: "", exitCode: 0 })
    } finally {
      rmSync(probe.root, { recursive: true, force: true })
    }
  }, 120_000)
})
