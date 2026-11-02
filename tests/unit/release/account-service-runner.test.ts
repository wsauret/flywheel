import { describe, expect, test } from "bun:test"

import {
  ACCOUNT_SERVICE_REQUIRED_METRICS,
  SESSION_SUMMARY_REQUIRED_METRICS,
  missingCandidateAccountServiceEvidence,
  missingCandidateSessionSummaryEvidence,
} from "../../release/types.js"

describe("account-service release evidence", () => {
  test("requires every candidate-only metric", () => {
    const metrics = Object.fromEntries(ACCOUNT_SERVICE_REQUIRED_METRICS.map((metric) => [metric, 1]))

    expect(missingCandidateAccountServiceEvidence(metrics)).toEqual([])
    delete metrics["accountService.open2Ms"]
    expect(missingCandidateAccountServiceEvidence(metrics)).toEqual(["accountService.open2Ms"])
  })

  test("rejects malformed candidate evidence", () => {
    const metrics = Object.fromEntries(ACCOUNT_SERVICE_REQUIRED_METRICS.map((metric) => [metric, 1]))
    metrics["accountService.zeroProjectRssMb"] = Number.NaN
    metrics["accountService.open3Ms"] = -1

    expect(missingCandidateAccountServiceEvidence(metrics)).toEqual([
      "accountService.zeroProjectRssMb",
      "accountService.open3Ms",
    ])
  })

  test("accepts a negative second-project delta as measured evidence", () => {
    const metrics = Object.fromEntries(ACCOUNT_SERVICE_REQUIRED_METRICS.map((metric) => [metric, 1]))
    metrics["accountService.secondProjectIncrementalRssMb"] = -2

    expect(missingCandidateAccountServiceEvidence(metrics)).toEqual([])
  })
})

describe("session-summary release evidence", () => {
  test("requires every metric and no unindexed plans", () => {
    const metrics = Object.fromEntries(SESSION_SUMMARY_REQUIRED_METRICS.map((metric) => [metric, 1]))
    metrics["sessionSummary.unindexedTypePlans"] = 0

    expect(missingCandidateSessionSummaryEvidence(metrics)).toEqual([])
    delete metrics["sessionSummary.pageTransactionP95Ms"]
    metrics["sessionSummary.unindexedTypePlans"] = 1
    expect(missingCandidateSessionSummaryEvidence(metrics)).toEqual([
      "sessionSummary.pageTransactionP95Ms",
      "sessionSummary.unindexedTypePlans",
    ])
  })
})
