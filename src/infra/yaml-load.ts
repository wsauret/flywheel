import { load, YAMLException, type LoadOptions } from "js-yaml";

const DEFICIENT_INDENTATION = "deficient indentation";

/** The most times that one text is loaded. Each raise loads the whole text
 *  again, so this bound keeps the cost of a text linear in its size. A file
 *  written for js-yaml 4 raises a few lines. */
const MAX_LOADS = 32;

/** A loaded YAML document, and the one-based numbers of the lines whose
 *  indentation the load raised. */
export interface LoadedYaml {
  readonly document: unknown;
  readonly raisedLines: readonly number[];
}

/** Load authored YAML as js-yaml 4 read it. js-yaml 5 refuses a line inside
 *  a flow collection or quoted text that is indented less than its key, and
 *  js-yaml 4 only warned about it, so files written for js-yaml 4 hold such
 *  lines. Inside flow content, YAML discards the leading spaces of a line,
 *  so each refused line gets more of them until the load passes, and the
 *  value is the value that js-yaml 4 read. A refused line first gets the
 *  indentation that the line raised before it reached, because the lines of
 *  one flow collection need the same indentation, and else twice its own.
 *  After {@link MAX_LOADS} loads the refusal is thrown. A YAMLException is
 *  thrown with its line and column in `text`. A refused load stops in the
 *  parse, before any tag of `options` constructs a value. */
export function loadYaml(text: string, options: LoadOptions): LoadedYaml {
  // The separators stay at the odd indexes, so the join gives back each line break as written.
  const parts = text.split(/(\r\n|\r|\n)/u);
  const raised = new Map<number, number>();
  let reach = 0;
  for (let loads = 1; ; loads++) {
    try {
      const document: unknown = load(raised.size === 0 ? text : parts.join(""), options);
      return { document, raisedLines: [...raised.keys()].sort((a, b) => a - b).map((line) => line + 1) };
    } catch (error) {
      if (!(error instanceof YAMLException) || error.mark === undefined) throw error;
      const { line, column, position } = error.mark;
      if (error.reason === DEFICIENT_INDENTATION && loads < MAX_LOADS) {
        const spaces = Math.max(column + 1, reach - column);
        reach = column + spaces;
        parts[2 * line] = `${" ".repeat(spaces)}${parts[2 * line] ?? ""}`;
        raised.set(line, (raised.get(line) ?? 0) + spaces);
        continue;
      }
      if (raised.size === 0) throw error;
      const shift = Math.min(raised.get(line) ?? 0, column);
      const before = [...raised].reduce((sum, [raisedLine, spaces]) => raisedLine < line ? sum + spaces : sum, 0);
      throw new YAMLException(error.reason, { ...error.mark, buffer: text, column: column - shift, position: position - before - shift, snippet: null });
    }
  }
}
