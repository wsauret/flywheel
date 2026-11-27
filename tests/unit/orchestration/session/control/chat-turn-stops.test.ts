import { expect, test } from "bun:test"
import { finalMessageFirstLine } from "../../../../../src/orchestration/session/control/chat-turn-stops"

test.each([
  ["a plain first line", "Fixed the test.\nDetails follow.", "Fixed the test."],
  ["a heading, a rule, and a fence before text", "## Result\n\n---\n```\nbuild passed\n```", "build passed"],
  ["a heading with no later text", "# All done", "All done"],
  ["list, quote, link, and code marks", "> - See [the log](https://example.test/log) in `out.txt`", "See the log in out.txt"],
  ["a heading in a quote before text", "> ## Result\n> The build passed.", "The build passed."],
  ["a setext heading before text", "Result\n======\n\nThe build passed.", "The build passed."],
  ["inline code with emphasis marks inside", "Run `a**b**` now.", "Run a**b** now."],
  ["single emphasis and strikethrough", "*Fixed* the _flaky_ ~~old~~ test.", "Fixed the flaky old test."],
  ["a link whose text has brackets", "See [the [main] log](https://example.test/(x)) now.", "See the [main] log now."],
  ["a soft line break in the first paragraph", "First **answer**.\nMore detail.", "First answer."],
  ["an empty message", "\n\n", ""],
])("the first line of %s", (_name, text, line) => {
  expect(finalMessageFirstLine(text)).toBe(line)
})

test("a first line longer than 300 characters is cut to 300 with an ellipsis, by character", () => {
  const line = finalMessageFirstLine(`${"\u{1F600}".repeat(400)}\nnext`)
  expect(Array.from(line)).toHaveLength(300)
  expect(line.endsWith("\u{1F600}…")).toBe(true)
  expect(finalMessageFirstLine("x".repeat(300))).toBe("x".repeat(300))
})
