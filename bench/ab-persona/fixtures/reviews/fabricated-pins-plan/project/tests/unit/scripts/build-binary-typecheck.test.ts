import { describe, expect, it } from "bun:test"

const buildBinarySource = await Bun.file(new URL("../../../scripts/build-binary.ts", import.meta.url)).text()
const runtimeLaunchSource = await Bun.file(new URL("../../../src/cli/runtime-launch.ts", import.meta.url)).text()
const classifierSource = await Bun.file(new URL("../../../src/orchestration/agent-runtime/tools/bash-mutation-classifier.ts", import.meta.url)).text()
const cliIndexSource = await Bun.file(new URL("../../../src/cli/index.ts", import.meta.url)).text()

describe("binary build typecheck gate", () => {
  it("typechecks before replacing the last build artifact", () => {
    const typecheck = buildBinarySource.indexOf("lint:tsc")
    const firstBuildMutation = buildBinarySource.indexOf("await rm(stagingDir")

    expect(typecheck).toBeGreaterThan(-1)
    expect(firstBuildMutation).toBeGreaterThan(typecheck)
  })

  it("excludes macOS metadata entries from the canonical payload archive", () => {
    const disableAppleDouble = buildBinarySource.indexOf('process.env.COPYFILE_DISABLE = "1"')
    const archive = buildBinarySource.indexOf("await $`tar -czf")

    expect(disableAppleDouble).toBeGreaterThan(-1)
    expect(archive).toBeGreaterThan(disableAppleDouble)
  })

  it("embeds every runtime Worker entry in standalone executables", () => {
    expect(buildBinarySource).toContain('join(ROOT, "src", "orchestration", "app-service", "worker-entry.ts")')
    expect(buildBinarySource).toContain('join(ROOT, "src", "orchestration", "agent-runtime", "tools", "bash-mutation-classifier-worker.ts")')
    expect(buildBinarySource).toContain('naming: { entry: "[name].[ext]" }')
    expect(buildBinarySource).toContain('const workerBundlePath = join(DIST, "worker-entry.js")')
    expect(buildBinarySource).toContain('const classifierWorkerBundlePath = join(DIST, "bash-mutation-classifier-worker.js")')
    expect(buildBinarySource).toContain('"./index.js",\n  "./worker-entry.js",\n  "./bash-mutation-classifier-worker.js",')
    expect(buildBinarySource).toContain("Bun.spawn(compileArgs, { cwd: DIST,")
    // Standalone worker specifiers are named on the executable's own module
    // mount, not relatively: Bun resolves nothing relative there. That the
    // specifiers actually resolve is proven against a compiled artifact in
    // tests/integration/local/compiled-worker-entry.test.ts; this gate only
    // keeps the source from drifting back to relative names.
    expect(runtimeLaunchSource).toContain('embeddedEntrySpecifier(import.meta.dir, "worker-entry.js")')
    expect(runtimeLaunchSource).not.toContain(': "./worker-entry.js"')
    expect(classifierSource).toContain('embeddedEntrySpecifier(import.meta.dir, "bash-mutation-classifier-worker.js")')
    expect(classifierSource).not.toContain(': "./bash-mutation-classifier-worker.js"')
    expect(cliIndexSource).not.toContain("if (!Bun.isMainThread)")
  })
})
