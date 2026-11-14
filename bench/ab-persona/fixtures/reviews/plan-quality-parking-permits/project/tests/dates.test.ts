import { expect, test } from "bun:test";
import { addDays, addMonths } from "../src/dates";

test("addMonths keeps the day or clamps to the month end", () => {
  expect(addMonths("2027-06-30", 12)).toBe("2028-06-30");
  expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
  expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
});

test("addDays crosses month ends", () => {
  expect(addDays("2027-06-30", -30)).toBe("2027-05-31");
  expect(addDays("2027-06-30", 14)).toBe("2027-07-14");
});
