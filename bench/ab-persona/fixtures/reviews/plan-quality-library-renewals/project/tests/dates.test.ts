import { expect, test } from "bun:test";
import { addDays, todayIn } from "../src/dates";

test("addDays crosses month and year ends", () => {
  expect(addDays("2027-01-25", 14)).toBe("2027-02-08");
  expect(addDays("2027-12-25", 14)).toBe("2028-01-08");
});

test("todayIn gives the calendar date in the zone", () => {
  expect(todayIn("America/Chicago", new Date("2027-05-11T03:00:00Z"))).toBe("2027-05-10");
});
