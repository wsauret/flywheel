import { describe, expect, test } from "bun:test"

import { formatAutoDeleteSessionDays, formatDateTime, parseAutoDeleteSessionDays } from "../../../../src/protocol/client/format.js"

test("automatic deletion reads as Off, one day, or plural days", () => {
  expect(formatAutoDeleteSessionDays(0)).toBe("Off")
  expect(formatAutoDeleteSessionDays(1)).toBe("1 day")
  expect(formatAutoDeleteSessionDays(14)).toBe("14 days")
})

describe("parseAutoDeleteSessionDays", () => {
  test("accepts Off, zero, whole days, and every displayed reading", () => {
    for (const [draft, value] of [["Off", 0], ["0", 0], ["14", 14], ["14 days", 14], ["1 day", 1]] as const) {
      expect(parseAutoDeleteSessionDays(draft)).toEqual({ value })
    }
  })

  test("refuses fractions, negative days, and an empty draft", () => {
    for (const draft of ["1.5", "-1", ""]) {
      expect(parseAutoDeleteSessionDays(draft)).toEqual({ problem: "Enter a whole number of days, or Off." })
    }
  })
})

describe("formatDateTime", () => {
  const now = new Date(2026, 8, 6, 20, 0).getTime()

  test("reads as a short date and a 24-hour clock to the minute, in local time", () => {
    expect(formatDateTime(new Date(2026, 8, 6, 17, 21, 43).getTime(), now)).toBe("Sep 6, 17:21")
    expect(formatDateTime(new Date(2026, 0, 3, 9, 5).getTime(), now)).toBe("Jan 3, 09:05")
    expect(formatDateTime(new Date(2026, 11, 31, 0, 0).getTime(), now)).toBe("Dec 31, 00:00")
  })

  test("names the year only when it is not this year", () => {
    expect(formatDateTime(new Date(2025, 8, 6, 17, 21).getTime(), now)).toBe("Sep 6, 2025, 17:21")
  })
})
