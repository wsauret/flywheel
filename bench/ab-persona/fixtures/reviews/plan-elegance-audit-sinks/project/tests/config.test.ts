import { expect, test } from "bun:test";
import { parseConfig } from "../src/config";

test("DATA_DIR is required", () => {
  expect(() => parseConfig({})).toThrow("DATA_DIR is required");
});
