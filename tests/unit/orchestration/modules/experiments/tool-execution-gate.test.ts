import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js"
import { experimentToolExecutionGate } from "../../../../../src/orchestration/modules/experiments/tool-execution-gate.js"
import { executePreparedTool, prepareToolCall, type ToolExecutionGateInput } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js"
import type { ExperimentGuardSnapshot, RuntimeTool, RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { editDefinition } from "../../../../../src/orchestration/agent-runtime/tools/edit.js"
import { readDefinition } from "../../../../../src/orchestration/agent-runtime/tools/read.js"
import { createBashDefinition } from "../../../../../src/orchestration/agent-runtime/tools/bash.js"
import { loadBashParser } from "../../../../../src/orchestration/agent-runtime/tools/bash-parser.js"
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { MANDATORY_PROTECTED_PATHS } from "../../../../../src/orchestration/modules/experiments/charter.js"
import { makeContext } from "../../agent-runtime/tools/_fixtures.js"
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js"

const snapshot = { active: true, initialized: true, workDir: "/repo", protectedPaths: ["tests/**"], sealedPaths: ["secret/**"] } as const
/** The experiments runtime as the gates see it: only the charter guard. */
const guardedRuntimes = (guard: ExperimentGuardSnapshot | undefined) => composeModuleRuntimes([["experiments", { guard: async () => guard }]])
const input = (name: string, args: RuntimeToolInput, paths: readonly string[] = [], guard: ExperimentGuardSnapshot = snapshot, tool = name): ToolExecutionGateInput =>
  Object.freeze({ call: Object.freeze({ id: "1", name, input: args }), tool, input: Object.freeze(args), sessionId: "s", executionCwd: guard.workDir, preparedReservedPaths: Object.freeze(paths), modules: guardedRuntimes(guard) })

describe("experiment tool execution gate", () => {
  const gate = experimentToolExecutionGate
  it("allows inactive and allowed paths", async () => {
    expect(await gate(input("write", { path: "tests/a" }, ["/repo/allowed/a"], { ...snapshot, active: false }))).toEqual({ kind: "allow" })
    expect(await gate(input("write", { path: "src/a" }, ["/repo/src/a"]))).toEqual({ kind: "allow" })
  })
  it("protects file mutations and sealed read/search traversal", async () => {
    // The gate names tools, so the patch registration of edit is covered by name `edit`.
    for (const [name, tool] of [["edit", "edit"], ["write", "write"], ["apply_patch", "edit"]] as const) {
      expect(await gate(input(name, {}, ["/repo/tests/a.ts"], snapshot, tool))).toEqual({ kind: "veto", reason: "experiment guard: tests/a.ts is protected by the charter" })
    }
    expect(await gate(input("read", { path: "secret/key" }))).toEqual({ kind: "veto", reason: "experiment guard: secret/key is protected by the charter" })
    expect(await gate(input("search", { pattern: "x", path: "." }))).toEqual({ kind: "veto", reason: "experiment guard: secret/** is protected by the charter" })
    expect(await gate(input("search", { pattern: "x", path: "src" }))).toEqual({ kind: "allow" })
  })
  it("vetoes mutation and delegation before initialization except init and charter inspection", async () => {
    const guard = { ...snapshot, initialized: false }
    expect(await gate(input("write", {}, ["/repo/src/a"], guard))).toMatchObject({ kind: "veto" })
    expect(await gate(input("subagent", {}, [], guard))).toMatchObject({ kind: "veto" })
    expect(await gate(input("read", { path: ".experiment/charter.md" }, [], guard))).toEqual({ kind: "allow" })
    expect(await gate(input("init_experiment", {}, [], guard))).toEqual({ kind: "allow" })
  })
})

describe("experiment gate through tool dispatch", () => {
  // Reserved paths are canonical (symlinks resolved), so the charter work
  // directory must be canonical too, as the Git toplevel is in production.
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-experiment-gate-")))
  const tools = new Map<string, RuntimeTool>([
    ["edit", editDefinition],
    ["read", readDefinition],
    ["bash", createBashDefinition()],
  ])
  const gate = composeFirstPartyModules().gates
    .find((declaration): declaration is Extract<typeof declaration, { readonly seam: "toolExecution" }> => declaration.seam === "toolExecution")?.gate
  const guard: ExperimentGuardSnapshot = { active: true, initialized: true, workDir, protectedPaths: [...MANDATORY_PROTECTED_PATHS], sealedPaths: ["secret/**"] }
  const dispatch = (name: string, args: RuntimeToolInput, experimentGuard?: () => ExperimentGuardSnapshot | undefined) =>
    executePreparedTool(
      prepareToolCall({ id: `call-${name}`, name, input: args }, tools, { ok: true }),
      makeContext({
        executionCwd: workDir, projectRoot: workDir,
        // As the exposure planner maps them: each registration to the tool it serves.
        toolNames: { logical: (presented) => ({ apply_patch: "edit" })[presented] ?? presented, presented: (logical) => logical },
        ...(experimentGuard ? { moduleRuntimes: guardedRuntimes(experimentGuard()) } : {}),
      }),
      { gate },
    )

  beforeAll(async () => {
    await loadBashParser()
    fs.mkdirSync(path.join(workDir, ".experiment"))
    fs.mkdirSync(path.join(workDir, "secret"))
    fs.writeFileSync(path.join(workDir, ".experiment", "charter.md"), "# Charter\n")
    fs.writeFileSync(path.join(workDir, "secret", "key"), "hidden\n")
    fs.writeFileSync(path.join(workDir, "notes.txt"), "draft\n")
  })
  afterAll(() => { fs.rmSync(workDir, { recursive: true, force: true }) })

  it("vetoes charter-protected and sealed calls from the context guard", async () => {
    const provider = () => guard
    const charterEdit = await dispatch("edit", { path: ".experiment/charter.md", old_string: "Charter", new_string: "Mine" }, provider)
    expect(charterEdit).toEqual({ content: "experiment guard: .experiment/charter.md is protected by the charter", outcome: "error" })
    expect(fs.readFileSync(path.join(workDir, ".experiment", "charter.md"), "utf8")).toBe("# Charter\n")

    const sealedRead = await dispatch("read", { path: "secret/key" }, provider)
    expect(sealedRead).toEqual({ content: "experiment guard: secret/key is protected by the charter", outcome: "error" })

    for (const args of [
      { path: "notes.txt secret/key" },
      { path: ".", pattern: "hidden" },
      { path: "." },
    ]) {
      const recovered = await dispatch("read", args, provider)
      expect(recovered.outcome).toBe("error")
      expect(recovered.content).toContain("protected by the charter")
      expect(recovered.content).not.toContain("1|hidden")
    }
  })

  it("vetoes every shell write that reaches a protected path", async () => {
    const forms: readonly (readonly [RuntimeToolInput, string])[] = [
      ...[
        "echo 'exit 0' > .experiment/measure.sh",
        "echo x | tee .experiment/measure.sh",
        "sed -i s/x/y/ .experiment/measure.sh",
        "perl -i -pe 's/x/y/' .experiment/measure.sh",
        "dd if=/dev/null of=.experiment/measure.sh",
        "install -m 755 notes.txt .experiment/measure.sh",
        "truncate -s 0 .experiment/measure.sh",
        "cp notes.txt .experiment/measure.sh",
        "cd .experiment && echo x > measure.sh",
        "if test -e q; then cd .experiment; fi; echo x > measure.sh",
      ].map((command) => [{ command }, ".experiment/measure.sh"] as const),
      [{ command: "echo x > measure.sh", cwd: ".experiment" }, ".experiment/measure.sh"],
      // Deleting or moving a directory that holds a protected path replaces it.
      [{ command: "rm -rf .experiment" }, ".experiment"],
      [{ command: "mv .experiment moved" }, ".experiment"],
    ]
    for (const [bashInput, target] of forms) {
      const expected = { content: `experiment guard: ${target} is protected by the charter`, outcome: "error" as const }
      expect(await dispatch("bash", bashInput, () => guard)).toEqual(expected)
    }
    expect(fs.existsSync(path.join(workDir, ".experiment", "measure.sh"))).toBe(false)
  })

  it("vetoes writes to a protected directory reached through a symbolic link", async () => {
    fs.mkdirSync(path.join(workDir, "actual"))
    fs.writeFileSync(path.join(workDir, "actual", "a"), "kept\n")
    // A junction on Windows needs no privilege; other platforms ignore the type.
    fs.symlinkSync(path.join(workDir, "actual"), path.join(workDir, "linked"), "junction")
    const linked = () => ({ ...guard, protectedPaths: ["linked/**"] })
    const expected = { content: "experiment guard: actual/a is protected by the charter", outcome: "error" as const }
    expect(await dispatch("bash", { command: "echo changed > linked/a" }, linked)).toEqual(expected)
    expect(await dispatch("edit", { path: "linked/a", old_string: "kept", new_string: "changed" }, linked)).toEqual(expected)
    expect(fs.readFileSync(path.join(workDir, "actual", "a"), "utf8")).toBe("kept\n")
  })

  it("allows a shell call that only reads a protected path or writes elsewhere", async () => {
    // Judged at the gate itself: an allowed call would go on to run the command.
    const shellInput = (command: string): ToolExecutionGateInput => Object.freeze({
      ...input("bash", { command }, [], guard, "bash"),
      shell: Object.freeze({ command, cwd: workDir }),
    })
    for (const command of ["cat .experiment/measure.sh", "echo x > notes.txt", "cp .experiment/measure.sh copy.sh"]) {
      expect(await experimentToolExecutionGate(shellInput(command))).toEqual({ kind: "allow" })
    }
  })

  it("allows in-scope mutation under an active guard and everything without a provider", async () => {
    const allowed = await dispatch("edit", { path: "notes.txt", old_string: "draft", new_string: "final" }, () => guard)
    expect(allowed.outcome).toBe("ok")
    expect(fs.readFileSync(path.join(workDir, "notes.txt"), "utf8")).toBe("final\n")

    const unguarded = await dispatch("read", { path: "secret/key" })
    expect(unguarded.outcome).toBe("ok")
    expect(String(unguarded.content)).toContain("hidden")
  })
})

describe("experiment omissions in the exposure plan", () => {
  const runtime = (guard: ExperimentGuardSnapshot | undefined) => ({
    tools: { initExperiment: stub("init_experiment"), runExperiment: stub("run_experiment"), logExperiment: stub("log_experiment") },
    finalizeGrant: () => ({ skillIds: [], run: async () => { throw new Error("unused") } }),
    guard: async () => guard,
  })
  // The exposure gate comes from the request's module snapshot, exactly as in production.
  const plan = (guard: ExperimentGuardSnapshot | undefined) => planToolExposure({
    kernel: testKernelToolDeps({
      userDataRoot: "/scratch",
      capabilities: { available: () => true },
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
    }),
    modules: composeModuleRuntimes([["experiments", runtime(guard)]]),
  })

  it("omits bash and subagent with the charter reasons while the loop is active", async () => {
    const active = await plan({ active: true, initialized: true, workDir: "/repo", protectedPaths: [], sealedPaths: ["secret/**"] })
    expect(active.tools.has("bash")).toBe(false)
    expect(active.omitted).toContainEqual({ name: "bash", reason: "sealed experiment paths cannot be exposed to Bash" })
    expect(active.omitted).toContainEqual({ name: "subagent", reason: "active experiment policy cannot be delegated" })
  })

  it("keeps bash when the loop is inactive or has no sealed paths", async () => {
    expect((await plan(undefined)).tools.has("bash")).toBe(true)
    expect((await plan({ active: false, initialized: true, workDir: "/repo", protectedPaths: [], sealedPaths: ["secret/**"] })).tools.has("bash")).toBe(true)
    const unsealed = await plan({ active: true, initialized: true, workDir: "/repo", protectedPaths: [], sealedPaths: [] })
    expect(unsealed.tools.has("bash")).toBe(true)
    expect(unsealed.omitted).toContainEqual({ name: "subagent", reason: "active experiment policy cannot be delegated" })
  })
})

function stub(name: string): RuntimeTool {
  return { name, action: "ui_meta", description: name, inputSchema: { type: "object", properties: {} }, isConcurrencySafe: true, execute: async () => ({ content: "", outcome: "ok" }) }
}
