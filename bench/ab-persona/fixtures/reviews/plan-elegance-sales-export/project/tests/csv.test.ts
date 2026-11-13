import { expect, test } from "bun:test";
import { toCsv } from "../src/format/csv";

test("cells with commas and quotes are quoted", () => {
  expect(toCsv(["a", "b"], [["x,y", 'say "hi"']])).toBe('a,b\r\n"x,y","say ""hi"""\r\n');
});
