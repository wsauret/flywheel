import { expect, test } from "bun:test";
import { parsePreferences } from "../src/preferences/parse";

test("invalid quiet hours take the defaults", () => {
  expect(parsePreferences({ quietHours: { start: "25:00" } }).quietHours).toEqual({ start: "22:00", end: "07:00" });
  expect(parsePreferences(undefined).quietHours).toEqual({ start: "22:00", end: "07:00" });
});
