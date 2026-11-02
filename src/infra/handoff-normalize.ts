/** Anthropic tool-call wire tag names. Single source of truth for the leaked-markup
 * vocabulary: the split below and the collapsed-markup detector
 * (`collapsedMarkup`) both derive from this list, so detection can never drift
 * from what the split understands. */
const WIRE_TAG_NAMES = ["invoke", "function_calls", "parameter", "parameters", "tool_call"] as const;

const WIRE_CLOSERS = WIRE_TAG_NAMES.join("|");
// Opens exclude `<parameter name="x">`: that tag names a field, so the split
// reads it as a fragment instead of skipping it.
const WIRE_OPENS = WIRE_TAG_NAMES.filter((name) => name !== "parameter").join("|");

// Anthropic-style tool-call wire scaffolding the model leaks between serialized
// arguments when it writes the handoff as a function call instead of a flat JSON
// object: closers plus attribute-bearing opens, with the whitespace around them.
const LEADING_SCAFFOLDING = new RegExp(`^(?:\\s|<\\/(?:${WIRE_CLOSERS})>|<(?:${WIRE_OPENS})(?:\\s[^>]*)?>)+`);
const TRAILING_SCAFFOLDING = new RegExp(`(?:\\s|<\\/(?:${WIRE_CLOSERS})>)+$`);

// Wire-format closers that can terminate the prose when the model never emitted `</key>`:
// in `<parameter name="summary">prose</parameter>...` the transport consumed the open tag,
// so the first closer is where the prose ends.
const BOUNDARY_FALLBACK = new RegExp(`<\\/(?:${WIRE_CLOSERS})>`);

// The seam between two serialized arguments: a closing tag, then, across
// whitespace only, a tool-call wire tag (`</artifacts>\n</invoke>`,
// `</summary>\n<parameter name="x">`).
const WIRE_SEAM = new RegExp(`<\\/[A-Za-z_][\\w-]*>\\s*<\\/?(?:${WIRE_CLOSERS})(?:\\s[^>]*)?>`);

// The open tag of one serialized argument: the wire form, which names the field
// in its attribute, or the element form, whose tag is the field name. The element
// form tolerates a mangled open such as `<artifacts">`.
const PARAMETER_OPEN = /^<parameter\s+name="([A-Za-z_][A-Za-z0-9_]*)"[^>]*>/;
const ELEMENT_OPEN = /^<([A-Za-z_][A-Za-z0-9_]*)[^>]*>/;

/**
 * The collapsed tool-call markup in the string value of field `key`, or
 * undefined when the value holds none. Markup is collapsed when a closing tag
 * is followed, across whitespace only, by another tag of a serialized call: a
 * wire tag after any closer, or any opening tag after the field's own closer
 * (`prose</summary>\n<artifacts>`). That seam is where the model ended one
 * argument and began the next inside a single string. Prose that quotes a tag,
 * such as "wraps it in <summary>...</summary> first", has no seam and is not
 * markup. Returns the closer that begins the seam.
 */
export function collapsedMarkup(key: string, value: string): string | undefined {
  const ownSeam = new RegExp(`<\\/${RegExp.escape(key)}>\\s*<[A-Za-z_][\\w-]*(?:\\s[^>]*)?>`);
  const seam = WIRE_SEAM.exec(value) ?? ownSeam.exec(value);
  return seam?.[0].slice(0, seam[0].indexOf(">") + 1);
}

/** One serialized argument read out of a collapsed value. */
interface CollapsedFragment {
  readonly name: string;
  /** The text between the fragment's tags, trimmed; never empty. */
  readonly body: string;
}

/** A string value that holds a serialized tool call, split at its argument seams. */
export interface CollapsedValue {
  /** The text before the first closing tag: the value of the field that held the markup. */
  readonly value: string;
  /** The arguments after that tag, in order, each body as written. */
  readonly fragments: readonly CollapsedFragment[];
}

/**
 * Splits a "collapsed handoff": the model serialized every argument as tool-call
 * markup inside the string value of field `key`, e.g.
 *   cause: "prose...</cause>\n<red_result>FAIL ...</red_result>\n</invoke>"
 *   red_result: "FAIL ...</parameter>\n<parameter name=\"cause\">prose</parameter>"
 * The value ends at `</key>` when present, else at the first wire-format closer
 * (BOUNDARY_FALLBACK). After it, the split reads `<name>body</name>` and
 * `<parameter name="name">body</parameter>` fragments in order, including a last
 * fragment left unclosed because the value stream was cut, and skips bare
 * tool-call scaffolding and empty fragments. It reads syntax only: the caller
 * decides from the tool's schema whether each name is a field and how each body
 * parses. Returns undefined when the value has no boundary or when anything but
 * fragments and scaffolding follows it, so prose that quotes a tag never splits.
 */
export function splitCollapsedValue(key: string, text: string): CollapsedValue | undefined {
  const boundary = collapsedBoundary(key, text);
  if (!boundary) return undefined;
  const value = text.slice(0, boundary.index).trim();
  const fragments: CollapsedFragment[] = [];
  let rest = text.slice(boundary.index + boundary.length);
  for (;;) {
    rest = rest.replace(LEADING_SCAFFOLDING, "");
    if (rest.length === 0) break;
    const parameter = PARAMETER_OPEN.exec(rest);
    const open = parameter ?? ELEMENT_OPEN.exec(rest);
    const name = open?.[1];
    if (!open || !name) return undefined;
    const closer = parameter ? "</parameter>" : `</${name}>`;
    const end = rest.indexOf(closer, open[0].length);
    const body = end === -1
      ? rest.slice(open[0].length).replace(TRAILING_SCAFFOLDING, "")
      : rest.slice(open[0].length, end);
    rest = end === -1 ? "" : rest.slice(end + closer.length);
    if (body.trim().length > 0) fragments.push({ name, body: body.trim() });
  }
  if (fragments.length === 0 && value.length === 0) return undefined;
  return { value, fragments };
}

function collapsedBoundary(key: string, fieldValue: string): { index: number; length: number } | undefined {
  const ownTag = `</${key}>`;
  const ownBoundary = fieldValue.indexOf(ownTag);
  if (ownBoundary !== -1) return { index: ownBoundary, length: ownTag.length };

  const fallback = BOUNDARY_FALLBACK.exec(fieldValue);
  // A lone closer at the very end of prose is more likely quoted content than a
  // leaked envelope; require further wire markup after it to corroborate collapse.
  if (!fallback) return undefined;
  if (fieldValue.slice(fallback.index + fallback[0].length).trim().length === 0) return undefined;
  return { index: fallback.index, length: fallback[0].length };
}
