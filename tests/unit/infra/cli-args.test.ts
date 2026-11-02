import { describe, expect, test } from "bun:test"
import { CliArgsError, parseArgsResult, parseTimeInput, requiredValue } from "../../../src/infra/cli-args.js"
import { parseArgs as parseEventSearchArgs, eventSearchUsage } from "../../../src/cli/event-search-args.js"

describe("cli args errors-as-values", () => {
  test("parseArgsResult returns the parsed value on success", () => {
    expect(parseArgsResult(() => requiredValue(["x"], 0, "--flag"))).toEqual({ ok: true, options: "x" })
  })

  test("parseArgsResult surfaces a CliArgsError thrown by a helper as a typed value, not a throw", () => {
    const result = parseArgsResult(() => requiredValue([], 0, "--flag"))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a parse failure")
    expect(result.error._tag).toBe("CliArgsError")
    expect(result.error.message).toBe("--flag requires a value")
  })

  test("parseArgsResult lets a non-CliArgsError escape as a real bug", () => {
    expect(() => parseArgsResult(() => { throw new TypeError("boom") })).toThrow("boom")
  })

  test("requiredValue and parseTimeInput throw the tagged CliArgsError", () => {
    expect(() => requiredValue([], 0, "--flag")).toThrow(CliArgsError)
    expect(() => parseTimeInput("not-a-date", "--since")).toThrow(CliArgsError)
  })

  test("event-search parseArgs returns parsed options for valid argv", () => {
    const result = parseEventSearchArgs(["--session", "abc", "--limit", "5", "pattern"])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected a parsed result")
    expect(result.options.sessionId).toBe("abc")
    expect(result.options.limit).toBe(5)
    expect(result.options.pattern).toBe("pattern")
    expect(result.options.timeoutSeconds).toBe(30)
  })

  test("event-search parseArgs bounds --timeout to one minute", () => {
    const accepted = parseEventSearchArgs(["--timeout", "60"])
    expect(accepted.ok && accepted.options.timeoutSeconds).toBe(60)
    for (const value of ["0", "61"]) {
      const rejected = parseEventSearchArgs(["--timeout", value])
      expect(!rejected.ok && rejected.error.message).toBe("--timeout must be between 1 and 60 seconds")
    }
  })

  test("event-search parseArgs rejects the root-owned --project-root option", () => {
    const result = parseEventSearchArgs(["--project-root", "/scratch/sandbox"])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a parse failure")
    expect(result.error.message).toBe("Unknown option: --project-root")
  })

  test("event-search parseArgs rejects the retired --base-dir spelling", () => {
    const result = parseEventSearchArgs(["--base-dir", "/scratch/sandbox"])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a parse failure")
    expect(result.error.message).toBe("Unknown option: --base-dir")
  })

  test("event-search parseArgs returns a typed parse error for an unknown flag", () => {
    const result = parseEventSearchArgs(["--nope"])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a parse failure")
    expect(result.error.message).toBe("Unknown option: --nope")
  })

  test("event-search parseArgs returns a typed parse error for a flag missing its value", () => {
    const result = parseEventSearchArgs(["--limit"])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a parse failure")
    expect(result.error.message).toContain("--limit requires a value")
  })

  test("event-search usage documents the canonical installed command", () => {
    expect(eventSearchUsage()).toContain("flywheel events search")
    expect(eventSearchUsage()).toContain("Recover a missed background result before rerunning work")
    expect(eventSearchUsage()).toContain("--type subagent.completed")
    expect(eventSearchUsage()).toContain("--type handoff.written")
    expect(eventSearchUsage()).toContain("--type chat.entries.appended")
    expect(eventSearchUsage()).not.toContain("events:search")
    expect(eventSearchUsage()).not.toContain("bun run")
  })
})
