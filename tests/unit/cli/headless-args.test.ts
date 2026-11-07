import { describe, expect, it } from "bun:test"
import { HEADLESS_USAGE, hasHeadlessAcpFlag, hasHeadlessJsonlFlag, headlessAuthProfile, headlessAuthSnapshot, headlessDeadlineSeconds, headlessDisabledTools, headlessEffort, headlessModel, headlessSystemPrompt, headlessTask, needsHeadlessUsage } from "../../../src/cli/headless-args.js"

describe("headless CLI args", () => {
  it("accepts bare headless chat", () => {
    expect(needsHeadlessUsage(["bun", "flywheel", "--headless"])).toBe(false)
  })

  it("leaves non-headless launches alone", () => {
    expect(needsHeadlessUsage(["bun", "flywheel"])).toBe(false)
  })

  it("keeps the CI usage text explicit", () => {
    expect(HEADLESS_USAGE).toContain("--headless")
    expect(HEADLESS_USAGE).not.toContain("--description")
    expect(HEADLESS_USAGE).not.toContain("--workflow")
  })

  it("reads ACP chat with its auth and tool selection", () => {
    const argv = ["--headless", "--acp", "--auth-profile", "benchmark", "--auth-snapshot", "/private/auth.json", "--disable-tool", "web"]
    expect(hasHeadlessAcpFlag(argv)).toBe(true)
    expect(needsHeadlessUsage(argv)).toBe(false)
    expect(headlessAuthProfile(argv)).toBe("benchmark")
    expect(headlessAuthSnapshot(argv)).toBe("/private/auth.json")
    expect(headlessDisabledTools(argv)).toEqual(["web"])
    expect(hasHeadlessAcpFlag(["--headless"])).toBe(false)
    expect(HEADLESS_USAGE).toContain("--acp")
  })

  it("accepts a direct task", () => {
    expect(needsHeadlessUsage(["bun", "flywheel", "--headless", "--task", "write run.py"])).toBe(false)
    expect(headlessTask(["bun", "flywheel", "--headless", "--task", "write run.py"])).toBe("write run.py")
    expect(headlessTask(["bun", "flywheel", "--headless", "--task=write run.py"])).toBe("write run.py")
  })

  it("parses the direct-task model and effort overrides in both forms", () => {
    expect(headlessModel(["--headless", "--task", "x", "--model", "gpt-6-1-sol"])).toBe("gpt-6.1-sol")
    expect(headlessModel(["--headless", "--task=x", "--model=claude-fable-5-1"])).toBe("claude-fable-5.1")
    expect(headlessModel(["--headless", "--task", "x"])).toBeUndefined()
    expect(headlessEffort(["--headless", "--task", "x", "--model=gpt-6.1-sol", "--effort", "low"])).toBe("low")
    expect(headlessEffort(["--headless", "--task", "x", "--model=gpt-6.1-sol"])).toBeUndefined()
  })

  it("rejects model and effort overrides outside a direct headless task", () => {
    expect(() => headlessModel(["--headless", "--model=m"])).toThrow("--model is only valid with --headless --task")
    expect(() => headlessModel(["--model=m"])).toThrow("--model is only valid with --headless --task")
    expect(() => headlessModel(["--headless", "--task", "x", "--model="])).toThrow("--model requires a non-empty value")
    expect(() => headlessEffort(["--headless", "--task", "x", "--effort=low"])).toThrow("--effort is only valid with --model")
    expect(() => headlessEffort(["--headless", "--task", "x", "--model=m", "--effort="])).toThrow("--effort requires a non-empty value")
  })

  it("parses headless auth selectors and snapshots", () => {
    expect(headlessAuthProfile(["--headless", "--task=x", "--auth-profile", "Work"])).toBe("Work")
    expect(headlessAuthSnapshot(["--headless", "--task=x", "--auth-snapshot=/private/auth.json"])).toBe("/private/auth.json")
    expect(HEADLESS_USAGE).toContain("--auth-profile")
    expect(HEADLESS_USAGE).toContain("--auth-snapshot")
  })

  it("parses repeatable disabled tools and rejects invalid exclusions", () => {
    expect(headlessDisabledTools(["--headless", "--task=x", "--disable-tool", "web", "--disable-tool=read"])).toEqual(["web", "read"])
    expect(() => headlessDisabledTools(["--task=x", "--disable-tool=web"])).toThrow("only valid with --headless")
    expect(() => headlessDisabledTools(["--headless", "--task=x", "--disable-tool"])).toThrow("requires a non-empty")
    expect(() => headlessDisabledTools(["--headless", "--task=x", "--disable-tool="])).toThrow("requires a non-empty")
    expect(() => headlessDisabledTools(["--headless", "--task=x", "--disable-tool=web", "--disable-tool", "web"])).toThrow("must not contain duplicates")
    expect(HEADLESS_USAGE).toContain("--disable-tool")
  })

  it("accepts a system prompt only for direct headless tasks", () => {
    expect(headlessSystemPrompt(["--headless", "--task=x", "--system-prompt", "custom\nprompt"])).toBe("custom\nprompt")
    expect(headlessSystemPrompt(["--headless", "--task=x", "--system-prompt=custom"])).toBe("custom")
    expect(() => headlessSystemPrompt(["--task=x", "--system-prompt=custom"])).toThrow("only valid with --headless --task")
    expect(() => headlessSystemPrompt(["--headless", "--system-prompt=custom"])).toThrow("only valid with --headless --task")
    expect(() => headlessSystemPrompt(["--headless", "--task=x", "--system-prompt="])).toThrow("requires a non-empty value")
    expect(() => headlessSystemPrompt(["--headless", "--task=x", "--system-prompt=a", "--system-prompt", "b"])).toThrow("must not be repeated")
  })

  it("treats an empty or option-shaped task as missing", () => {
    expect(needsHeadlessUsage(["bun", "flywheel", "--headless", "--task", ""])).toBe(true)
    expect(needsHeadlessUsage(["bun", "flywheel", "--headless", "--task", "--print-logs"])).toBe(true)
    expect(headlessTask(["bun", "flywheel"])).toBeUndefined()
  })

  it("parses a positive finite deadline for direct tasks", () => {
    expect(headlessDeadlineSeconds(["--headless", "--task", "x", "--deadline-seconds", "1.5"])).toBe(1.5)
    expect(headlessDeadlineSeconds(["--headless", "--task=x", "--deadline-seconds=2"])).toBe(2)
    expect(headlessDeadlineSeconds(["--headless", "--task", "x"])).toBeUndefined()
  })

  it("rejects invalid or non-headless deadlines", () => {
    for (const value of ["0", "-1", "Infinity", "NaN"]) {
      expect(() => headlessDeadlineSeconds(["--headless", "--task", "x", `--deadline-seconds=${value}`])).toThrow("positive finite number")
    }
    expect(() => headlessDeadlineSeconds(["--task", "x", "--deadline-seconds=1"])).toThrow("only valid with --headless")
  })

  it("accepts JSONL only for headless launches", () => {
    expect(hasHeadlessJsonlFlag(["--headless", "--task", "x", "--jsonl"])).toBe(true)
    expect(hasHeadlessJsonlFlag(["--headless", "--task", "x"])).toBe(false)
    expect(() => hasHeadlessJsonlFlag(["--jsonl"])).toThrow("only valid with --headless")
  })

  it("ignores the root persistent-process override when it reads headless payloads", () => {
    const taskArgs = ["bun", "flywheel", "--headless", "--task", "ship it", "--allow-persistent-processes"]
    expect(headlessTask(taskArgs)).toBe("ship it")
    expect(needsHeadlessUsage(taskArgs)).toBe(false)

  })

  it("names launch options in the usage text", () => {
    expect(HEADLESS_USAGE).toContain("--task")
    expect(HEADLESS_USAGE).toContain("--allow-persistent-processes")
    expect(HEADLESS_USAGE).toContain("shared production runner")
    expect(HEADLESS_USAGE).not.toContain("hardcoded efficiency")
    expect(HEADLESS_USAGE).not.toContain("task-profile.ts")
  })
})
