import { describe, expect, test } from "bun:test"

import { rootCliAction } from "../../../src/cli/root-args.js"
import { rootUsage } from "../../../src/cli/root-help.js"
import { SUBCOMMANDS, isSubcommand } from "../../../src/cli/subcommands.js"
import { installedCliNouns } from "../../../src/orchestration/modules.js"

describe("root CLI args", () => {
  test("refuses retired headless workflow selectors before startup", async () => {
    for (const args of [
      ["--headless", "--description", "x"],
      ["--headless", "--workflow=debug"],
      ["--headless", "--description", "x", "--workflow", "debug", "--jsonl"],
      ["--headless", "--task=x", "--workflow=debug", "--jsonl"],
    ]) {
      expect(await rootCliAction(args)).toEqual({
        kind: "error",
        message: 'Headless workflow mode is retired: --description and --workflow no longer start a workflow. Run "flywheel --headless" for a headless chat, whose agent writes and launches workflows, or "flywheel --headless --task <text>" for one direct task.',
      })
    }
  })
  test("accepts headless chat resume without a legacy selector", async () => {
    expect(await rootCliAction(["--headless", "--session", "saved-chat"])).toEqual({
      kind: "run", args: ["--headless", "--session", "saved-chat"],
    })
    expect((await rootCliAction(["--session", "saved-chat"])).kind).toBe("error")
    expect(await rootCliAction(["--headless", "--one-shot"])).toEqual({ kind: "run", args: ["--headless", "--one-shot"] })
    expect(await rootCliAction(["--headless", "--one-shot", "--disable-tool", "subagent"])).toEqual({ kind: "run", args: ["--headless", "--one-shot", "--disable-tool", "subagent"] })
    expect((await rootCliAction(["--headless", "--task=x", "--one-shot"])).kind).toBe("error")
    for (const flag of ["--deadline-seconds=30", "--model=m", "--effort=low", "--system-prompt=x"]) {
      expect((await rootCliAction(["--headless", flag])).kind).toBe("error")
    }
    const acp = ["--headless", "--acp", "--auth-profile=benchmark", "--auth-snapshot", "/scratch/auth.json", "--disable-tool", "web"]
    expect(await rootCliAction([...acp, "--allow-persistent-processes"])).toEqual({ kind: "run", args: acp, allowPersistentProcesses: true })
    expect(await rootCliAction([...acp, "--unattended"])).toEqual({ kind: "run", args: [...acp, "--unattended"] })
    for (const refused of [["--acp"], ["--headless", "--acp", "--task", "x"], ["--headless", "--acp", "--session", "s"], ["--headless", "--acp", "--one-shot"], ["--headless", "--unattended"], ["--headless", "--task", "x", "--unattended"], ["--unattended"]]) {
      expect((await rootCliAction(refused)).kind).toBe("error")
    }
  })
  test("handles informational flags before runtime startup", async () => {
    expect(await rootCliAction(["--version"])).toEqual({ kind: "version" })
    expect(await rootCliAction(["-v"])).toEqual({ kind: "version" })
    expect(await rootCliAction(["--help"])).toEqual({ kind: "help" })
    expect(await rootCliAction(["-h"])).toEqual({ kind: "help" })
  })

  test("uses canonical CLI terminology in root help", async () => {
    const usage = await rootUsage()
    expect(usage).toContain("flywheel <subcommand> [args]")
    expect(usage).toContain("Subcommands:")
    expect(usage).not.toContain("<command>")
    expect(usage).not.toContain("Commands:")
  })

  test("lets launch-affecting flags start the relevant runtime path", async () => {
    expect(await rootCliAction([])).toEqual({ kind: "run", args: [] })
    expect(await rootCliAction(["--print-logs"])).toEqual({ kind: "run", args: ["--print-logs"] })
    expect(await rootCliAction(["--headless", "--task", "ship it"])).toEqual({ kind: "run", args: ["--headless", "--task", "ship it"] })
  })

  test("passes generic headless tool, prompt, and auth options to the headless owner", async () => {
    const args = ["--headless", "--task", "ship it", "--system-prompt", "literal", "--disable-tool", "web", "--auth-profile=Work", "--auth-snapshot", "/private/auth.json"]
    expect(await rootCliAction(args)).toEqual({ kind: "run", args })
    expect(await rootCliAction(["--system-prompt", "literal"])).toEqual({ kind: "error", message: "--system-prompt is only valid with --headless --task" })
    expect(await rootCliAction(["--headless", "--task", "ship", "--interaction-profile=profile"])).toEqual({ kind: "error", message: "Unknown option: --interaction-profile=profile" })
  })

  test("constrains the direct-task model and effort overrides", async () => {
    const valid = ["--headless", "--task", "notes", "--model", "gpt-6.1-sol", "--effort", "low"]
    expect(await rootCliAction(valid)).toEqual({ kind: "run", args: valid })
    expect(await rootCliAction(["--headless", "--model", "gpt-6.1-sol"]))
      .toEqual({ kind: "error", message: "--model is only valid with --headless --task" })
    expect(await rootCliAction(["--model", "gpt-6.1-sol"]))
      .toEqual({ kind: "error", message: "--model is only valid with --headless --task" })
    expect(await rootCliAction(["--headless", "--task", "notes", "--effort", "low"]))
      .toEqual({ kind: "error", message: "--effort is only valid with --model" })
    expect(await rootCliAction(["--headless", "--task", "notes", "--model="]))
      .toEqual({ kind: "error", message: "--model requires a value" })
    expect(await rootCliAction(["--headless", "--task", "notes", "--model"]))
      .toEqual({ kind: "error", message: "--model requires a value" })
  })

  test("extracts the invocation-only persistent-process override from every launch mode", async () => {
    expect(await rootCliAction(["--allow-persistent-processes"])).toEqual({
      kind: "run",
      args: [],
      allowPersistentProcesses: true,
    })
    expect(await rootCliAction(["--headless", "--task", "ship it", "--allow-persistent-processes"])).toEqual({
      kind: "run",
      args: ["--headless", "--task", "ship it"],
      allowPersistentProcesses: true,
    })
    expect(await rootCliAction(["--headless", "--allow-persistent-processes"])).toEqual({
      kind: "run",
      args: ["--headless"],
      allowPersistentProcesses: true,
    })
  })

  test("extracts the remote launch, which opens only a terminal and names no local project", async () => {
    expect(await rootCliAction(["--remote"])).toEqual({ kind: "run", args: [], remote: true })
    expect(await rootCliAction(["--remote", "--print-logs"])).toEqual({ kind: "run", args: ["--print-logs"], remote: true })
    expect(await rootCliAction(["--remote", "--headless"])).toEqual({ kind: "error", message: "--remote opens the terminal; it is not valid with --headless" })
    expect(await rootCliAction(["--remote", "web"])).toEqual({ kind: "error", message: "--remote opens the terminal; it is not valid with a subcommand" })
    expect(await rootCliAction(["--remote", "--project-root", "/scratch"])).toEqual({ kind: "error", message: "--remote opens a project on another machine; it is not valid with --project-root" })
  })

  test("rejects value forms of the persistent-process override", async () => {
    expect(await rootCliAction(["--allow-persistent-processes=true"])).toEqual({
      kind: "error",
      message: "Unknown option: --allow-persistent-processes=true",
    })
  })

  test("passes canonical subcommands through to their owners", async () => {
    expect(await rootCliAction(["auth", "--help"])).toEqual({ kind: "run", args: ["auth", "--help"] })
    expect(await rootCliAction(["font", "install"])).toEqual({ kind: "run", args: ["font", "install"] })
    expect(await rootCliAction(["update"])).toEqual({ kind: "run", args: ["update"] })
    expect(await rootCliAction(["web"])).toEqual({ kind: "run", args: ["web"] })
    expect(await rootCliAction(["events", "maintain", "--stats"])).toEqual({ kind: "run", args: ["events", "maintain", "--stats"] })
  })

  test("rejects every retired root command spelling", async () => {
    const retired = ["events:search", "skills:list", "skills:why", "skills:restore", "skills:prune", "skills:consolidate", "skills:doctor", "memory:show", "maintain", "workflow:verify"]
    for (const name of retired) {
      expect(await isSubcommand(name)).toBe(false)
      expect(await rootCliAction([name])).toEqual({ kind: "error", message: `Unknown subcommand or argument: ${name}` })
      expect(await rootCliAction([name, "--help"])).toEqual({ kind: "error", message: `Unknown subcommand or argument: ${name}` })
    }
  })

  test("guard recognizes exactly the dispatchable subcommands (one source of truth)", async () => {
    const moduleNouns = [...installedCliNouns().keys()]
    expect(moduleNouns).toEqual(expect.arrayContaining(["skills", "memory", "workflow"]))
    // Module nouns come from the catalog alone; the kernel table types none of them.
    for (const noun of moduleNouns) expect(Object.hasOwn(SUBCOMMANDS, noun)).toBe(false)
    for (const name of [...Object.keys(SUBCOMMANDS), ...moduleNouns]) {
      expect(await isSubcommand(name)).toBe(true)
      expect(await rootCliAction([name])).toEqual({ kind: "run", args: [name] })
    }
    // A name neither the kernel table nor the catalog registers is never treated as a run command.
    expect(await isSubcommand("not-a-subcommand")).toBe(false)
    expect(await rootCliAction(["not-a-subcommand"])).toEqual({
      kind: "error",
      message: "Unknown subcommand or argument: not-a-subcommand",
    })
  })

  test("rejects unknown root flags and arguments instead of opening the TUI", async () => {
    expect(await rootCliAction(["--wat"])).toEqual({ kind: "error", message: "Unknown option: --wat" })
    expect(await rootCliAction(["wat"])).toEqual({ kind: "error", message: "Unknown subcommand or argument: wat" })
    expect(await rootCliAction(["--description", "ship it"])).toEqual({ kind: "error", message: "Unknown option: --description" })
    expect(await rootCliAction(["--workflow=plan-implement"])).toEqual({ kind: "error", message: "Unknown option: --workflow=plan-implement" })
  })

  test("accepts deadlines for direct tasks and rejects them without headless", async () => {
    expect(await rootCliAction(["--headless", "--task", "ship it", "--deadline-seconds", "30"])).toEqual({
      kind: "run",
      args: ["--headless", "--task", "ship it", "--deadline-seconds", "30"],
    })
    expect(await rootCliAction(["--deadline-seconds", "30"])).toEqual({ kind: "error", message: "Unknown option: --deadline-seconds" })
  })

  test("accepts system prompts only for direct headless tasks", async () => {
    expect(await rootCliAction(["--headless", "--task", "ship it", "--system-prompt", "custom"])).toEqual({
      kind: "run",
      args: ["--headless", "--task", "ship it", "--system-prompt", "custom"],
    })
    expect(await rootCliAction(["--headless", "--system-prompt", "custom"])).toEqual({ kind: "error", message: "--system-prompt is only valid with --headless --task" })
    expect(await rootCliAction(["--system-prompt", "custom"])).toEqual({ kind: "error", message: "--system-prompt is only valid with --headless --task" })
  })

  test("accepts JSONL only with headless", async () => {
    expect(await rootCliAction(["--headless", "--task", "ship it", "--jsonl"])).toEqual({
      kind: "run",
      args: ["--headless", "--task", "ship it", "--jsonl"],
    })
    expect(await rootCliAction(["--jsonl"])).toEqual({ kind: "error", message: "--jsonl is only valid with --headless" })
  })

  test("documents root informational flags", async () => {
    const usage = await rootUsage()
    expect(usage).toContain("--version")
    expect(usage).toContain("--help")
    expect(usage).toContain("--project-root")
    expect(usage).toContain("--print-logs")
    expect(usage).toContain("--headless")
    expect(usage).not.toContain("--description")
    expect(usage.split("Options:")[1]).not.toContain("--workflow")
    expect(usage).toContain("--system-prompt")
    expect(usage).not.toContain("--interaction-profile")
    expect(usage).toContain("request-audit history")
    expect(usage).toContain("--allow-persistent-processes")
    expect(usage).toContain("  update ")
    expect(usage).toContain("  web ")
    // Every row keeps its description column and wraps to 80 columns; a label
    // that reaches the column keeps a fitting description on its line.
    expect(Math.max(...usage.split("\n").map((line) => line.length))).toBeLessThanOrEqual(80)
    expect(usage).toContain("  kill [--dry-run]          Stop every Flywheel process on this machine. The\n                            hard reset, for a runtime nothing else will end.")
    expect(usage).toContain("  auth login --<provider>   Sign in to one provider, such as --copilot.")
    expect(usage).toContain("  events evidence --session <id>  Read durable execution evidence as JSON.")
    expect(usage).toContain("  headless snapshot-auth --auth-profile <profile> --output <absolute-path>\n                            Export one auth profile")
    expect(usage).toContain("  --deadline-seconds <n>  Positive finite deadline in seconds for --task.")
    expect(usage).toContain("  --disable-tool <name>\n                   Disable one active first-party tool for a headless chat or\n                   direct task.")
    // A headless form wraps between bracketed groups, never inside one.
    expect(usage).toContain("                   flywheel --headless [--session <id>] [--one-shot]\n                     [--disable-tool <name>]... [--auth-profile <profile>]\n                     [--auth-snapshot <absolute-path>] [--jsonl] (JSONL Chat)")
    // Module nouns list from the catalog, one row per verb, in the kernel row layout.
    expect(usage).toContain("  skills why <name>         Trace a skill's loads and writes to sessions and\n                            requests.")
    expect(usage).toContain("  workflow verify <file>    Verify a workflow file compiles and is sound. With\n                            --workflow <id>, replay a workflow read-only.")
    expect(usage).toContain("  remote projects [forget <root>]\n                            List projects a phone can open, or forget one.")
    expect(usage).toContain("interactive")
    expect(usage).toContain("FLYWHEEL_PROJECT_ROOT")
    expect(usage).toContain(".flywheel")
  })
})
