import { findNodeAtLocation, parseTree, printParseErrorCode, type JSONPath, type Node, type ParseError } from "jsonc-parser";

type JsonPathSegment = string | number;

/** Strict JSON text that can answer where a value sits in the file. A model
 *  repairs a rejected document with a line-oriented editor, so every issue it
 *  receives names a line it can open; a JSON path alone sends it back to read
 *  the whole file. */
export interface JsonSource {
  readonly value: unknown;
  /** 1-based line of the deepest value on `path` that exists in the text. A
   *  path whose tail is absent (a missing key) resolves to the object that
   *  should contain it, which is where the repair goes. Undefined only for an
   *  empty document. */
  lineOf(path: readonly JsonPathSegment[]): number | undefined;
}

/** A parse failure located in the text, with the lines around it. */
export class JsonSyntaxError extends Error {
  override readonly name = "JsonSyntaxError";
  constructor(
    readonly line: number,
    readonly column: number,
    readonly reason: string,
    /** Numbered source lines around the failure with the failing line marked. */
    readonly excerpt: string,
  ) {
    super(`line ${line}, column ${column}: ${reason}\n${excerpt}`);
  }
}

const STRICT = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false } as const;
const EXCERPT_BEFORE = 2;
const EXCERPT_AFTER = 1;

function reasonFor(code: ReturnType<typeof printParseErrorCode>): string {
  switch (code) {
    case "PropertyNameExpected": return "expected a quoted property name";
    case "ValueExpected": return "expected a value";
    case "ColonExpected": return "expected ':' after the property name";
    case "CommaExpected": return "expected ',' between items";
    case "CloseBraceExpected": return "expected '}'";
    case "CloseBracketExpected": return "expected ']'";
    case "EndOfFileExpected": return "unexpected content after the end of the JSON document";
    case "UnexpectedEndOfString": return "unterminated string; a line break inside a string must be written as \\n";
    case "InvalidCharacter": return "invalid character inside a string; control characters must be escaped";
    case "InvalidEscapeCharacter": return "invalid escape sequence";
    case "InvalidUnicode": return "invalid \\u escape";
    case "InvalidNumberFormat":
    case "UnexpectedEndOfNumber": return "malformed number";
    case "InvalidCommentToken":
    case "UnexpectedEndOfComment": return "comments are not allowed in JSON";
    case "InvalidSymbol": return "unexpected token";
    case "<unknown ParseErrorCode>": return "invalid JSON";
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

/** 1-based line of `offset`, by binary search over the line starts. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    // SAFETY: mid is within [0, starts.length) by the loop bounds.
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function excerptAround(lines: readonly string[], line: number, column: number): string {
  const first = Math.max(1, line - EXCERPT_BEFORE);
  const last = Math.min(lines.length, line + EXCERPT_AFTER);
  const width = String(last).length;
  const rows: string[] = [];
  for (let number = first; number <= last; number += 1) {
    const marker = number === line ? ">" : " ";
    rows.push(`${marker} ${String(number).padStart(width)} | ${lines[number - 1] ?? ""}`);
    if (number === line) rows.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, column - 1))}^`);
  }
  return rows.join("\n");
}

function syntaxError(text: string, starts: readonly number[], error: ParseError, fallback: string): JsonSyntaxError {
  const line = lineAt(starts, error.offset);
  // SAFETY: lineAt returns a 1-based index into starts.
  const column = error.offset - starts[line - 1]! + 1;
  const reason = error.error === undefined ? fallback : reasonFor(printParseErrorCode(error.error));
  return new JsonSyntaxError(line, column, reason, excerptAround(text.split("\n"), line, column));
}

/** Parse strict JSON. Throws `JsonSyntaxError` with the failure's line,
 *  column, and surrounding lines when the text is not JSON. */
export function parseJsonSource(text: string): JsonSource {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const errors: ParseError[] = [];
    const starts = lineStarts(text);
    parseTree(text, errors, STRICT);
    const fallback = error instanceof Error ? error.message : String(error);
    const first = errors[0];
    // JSON.parse and the locating parser agree on every practical failure; the
    // fallback keeps the strict verdict when the locating parser is lenient.
    throw first ? syntaxError(text, starts, first, fallback) : new JsonSyntaxError(1, 1, fallback, excerptAround(text.split("\n"), 1, 1));
  }
  let tree: Node | undefined | null = null;
  let starts: number[] | undefined;
  return {
    value,
    lineOf(path) {
      if (tree === null) tree = parseTree(text, [], STRICT);
      if (tree === undefined) return undefined;
      starts ??= lineStarts(text);
      const segments: JSONPath = path.map((segment) => (typeof segment === "string" && /^\d+$/.test(segment) ? Number(segment) : segment));
      for (let length = segments.length; length >= 0; length -= 1) {
        const node = length === 0 ? tree : findNodeAtLocation(tree, segments.slice(0, length));
        if (node) return lineAt(starts, node.offset);
      }
      return undefined;
    },
  };
}
