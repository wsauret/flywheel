import { expect, test } from "bun:test";
import { buildIndex } from "../src/search/build";
import { parseNote } from "../src/notes/store";
import { search } from "../src/search/query";

test("every query word must match", () => {
  const index = buildIndex([parseNote("a.md", "# Garden\nplant tomatoes"), parseNote("b.md", "# Kitchen\ncook tomatoes")]);
  expect(search(index, "tomatoes")).toEqual(["a.md", "b.md"]);
  expect(search(index, "cook tomatoes")).toEqual(["b.md"]);
});
