import { expect, test } from "bun:test";
import { formatQuantity } from "../src/quantity";

test("kitchen measures round to quarters and never show below 1/4", () => {
  expect(formatQuantity(1.5, "cup")).toBe("1 1/2 cup");
  expect(formatQuantity(0.333, "cup")).toBe("1/4 cup");
  expect(formatQuantity(0.05, "tsp")).toBe("1/4 tsp");
  expect(formatQuantity(2, "tbsp")).toBe("2 tbsp");
});

test("weights round to whole numbers and pieces round up", () => {
  expect(formatQuantity(212.4, "g")).toBe("212 g");
  expect(formatQuantity(0.3, "ml")).toBe("1 ml");
  expect(formatQuantity(0.5, "piece")).toBe("1");
  expect(formatQuantity(2, "piece")).toBe("2");
});
