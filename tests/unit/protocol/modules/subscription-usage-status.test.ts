import { describe, expect, it } from "bun:test"
import { usageStatusLine, type UsageReadFailure } from "../../../../src/protocol/modules/subscription-usage.js"

const asOf = new Date(2026, 10, 9, 16, 16).getTime()
const time = new Date(asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
const line = (loading: boolean, shown: number | undefined, failure?: UsageReadFailure) => usageStatusLine({ loading, asOf: shown, failure, waiting: "Fetching usage...", ellipsis: "..." })

describe("usageStatusLine", () => {
  it("gives the reading's time while idle and says when it refreshes", () => {
    expect(line(false, asOf)).toEqual({ text: `As of ${time}`, tone: "muted" })
    expect(line(true, asOf)).toEqual({ text: "Refreshing...", tone: "muted" })
    expect(line(true, undefined)).toEqual({ text: "Fetching usage...", tone: "muted" })
  })

  it("keeps the reading's time beside a delay or a failed refresh, and warns only for a failure", () => {
    expect(line(false, asOf, { kind: "delayed" })).toEqual({ text: `As of ${time} · update delayed`, tone: "muted" })
    expect(line(false, asOf, { kind: "failed", cause: "provider check failed" })).toEqual({ text: `As of ${time} · refresh failed`, tone: "warning" })
    expect(line(true, asOf, { kind: "failed", cause: "provider check failed" })).toEqual({ text: "Refreshing...", tone: "muted" })
  })

  it("without a reading, keeps waiting through a delay and gives a failure's first line for the body", () => {
    expect(line(false, undefined, { kind: "delayed" })).toEqual({ text: "Fetching usage...", tone: "muted" })
    expect(line(false, undefined, { kind: "failed", cause: "Usage ledger is locked\n    at read (ledger.ts:1)" })).toEqual({ text: "Could not read usage", tone: "warning", detail: "Usage ledger is locked" })
  })
})
