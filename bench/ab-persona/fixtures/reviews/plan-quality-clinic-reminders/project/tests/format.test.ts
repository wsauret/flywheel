import { expect, test } from "bun:test";
import { formatSlot } from "../src/format";

test("formatSlot writes the weekday, date, and 24-hour time", () => {
  expect(formatSlot(new Date("2027-01-12T09:30:00Z"))).toBe("Tue 12 Jan 2027, 09:30");
});
