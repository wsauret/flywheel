import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { commandLineArguments, harnessOwns, identifyProcess, killIdentifiedProcess, RELEASE_HARNESS_ENVIRONMENT } from "../../helpers/real-process-fixture.js"

const MARKER = `FLYWHEEL_INTERNAL_RELEASE_HARNESS=${RELEASE_HARNESS_ENVIRONMENT.FLYWHEEL_INTERNAL_RELEASE_HARNESS}`

describe("harness process ownership", () => {
  it.each(["/workspace/gate", "C:\\workspace\\gate"])("matches %s and paths below it, not siblings that share a prefix", (root) => {
    const separator = root.includes("\\") ? "\\" : "/"
    const owns = (argv: readonly string[], environment: readonly string[] = [MARKER]) => harnessOwns({ argv, environment }, root)
    expect(owns(["bun", `${root}${separator}candidate${separator}flywheel`, "serve"])).toBe(true)
    expect(owns(["bun", `--home=${root}`])).toBe(true)
    expect(owns(["bun"], [MARKER, `HOME=${root}${separator}home`])).toBe(true)
    expect(owns(["bun", `${root}${separator}a file.ts`])).toBe(true)
    expect(owns(["bun", `${root}3.ps1`])).toBe(false)
    expect(owns(["bun", `${root}-other${separator}flywheel`])).toBe(false)
    expect(owns(["bun", `${root}.ps1`])).toBe(false)
    expect(owns(["bun", `${root} other${separator}c.ts`])).toBe(false)
    expect(owns(["bun"], [MARKER, `HOME=${root} other`])).toBe(false)
    expect(owns(["bun"], [MARKER, `HOME=${root}3.ps1`])).toBe(false)
  })

  it("requires the release harness marker, and refuses a process whose environment is unreadable", () => {
    const root = "C:\\workspace\\gate"
    expect(harnessOwns({ argv: ["bun", `${root}\\b.ts`], environment: [`HOME=${root}`] }, root)).toBe(false)
    expect(harnessOwns({ argv: ["bun", `${root}\\b.ts`], environment: undefined }, root)).toBe(false)
  })

  it("reads quoted Windows command-line paths whole", () => {
    const root = "C:\\workspace\\gate"
    const owns = (line: string) => harnessOwns({ argv: commandLineArguments(line), environment: [MARKER] }, root)
    expect(commandLineArguments(`"C:\\workspace\\gate other\\c.exe" serve`)).toEqual(["C:\\workspace\\gate other\\c.exe", "serve"])
    expect(owns(`"C:\\workspace\\gate other\\c.exe" serve`)).toBe(false)
    expect(owns(`bun "C:\\workspace\\gate\\a b.ts"`)).toBe(true)
    expect(owns(`bun --home="C:\\workspace\\gate"`)).toBe(true)
    expect(owns(`bun "C:\\workspace\\gate3.ps1"`)).toBe(false)
  })
})

describe("identified process kill", () => {
  const spies: { mockRestore(): void }[] = []
  afterEach(() => {
    // Restores every spy, so a failed expectation never leaves kills stubbed.
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  it("refuses to signal a pid whose snapshot identity is stale", () => {
    const current = identifyProcess(process.pid)
    if (!current) throw new Error("this process was not identifiable")
    const signals = spyOn(process, "kill").mockImplementation(() => true)
    const launches = spyOn(Bun, "spawnSync")
    spies.push(signals, launches)

    killIdentifiedProcess({ ...current, identity: `${current.identity} recycled` })

    expect(signals).not.toHaveBeenCalled()
    expect(launches.mock.calls.filter(([command]) => Array.isArray(command) && command[0] === "taskkill")).toEqual([])
  })
})
