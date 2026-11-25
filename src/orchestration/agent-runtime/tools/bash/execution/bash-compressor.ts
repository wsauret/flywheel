/**
 * Line selection and omission markers for shell observations. A rule only
 * chooses which real lines to keep; `renderShellLines` is the one writer of
 * inline omission markers, so every dropped run is marked where it occurred
 * and counted against the command's real output.
 */

/** Output the capture did not keep, between the head and the tail. A
 *  `lines` gap holds whole lines; a `characters` gap cuts through one line,
 *  because no line boundary fell inside the captured window. */
export interface ShellGap {
  readonly unit: "lines" | "characters";
  readonly count: number;
}

/** The real lines of one command's output, in order, around an optional gap. */
export interface ShellLines {
  readonly head: readonly string[];
  readonly gap?: ShellGap;
  readonly tail: readonly string[];
}

export interface RenderedShellLines {
  readonly output: string;
  /** Whether a rule dropped any real line. A capture gap alone does not count. */
  readonly compressed: boolean;
}

/** Where one real line sits in the output: the bytes before it, and the
 *  bytes after it, which are infinite for a line before a capture gap. */
interface LinePlace {
  readonly before: number;
  readonly after: number;
}

/** Keeps one real line at its place in the output. */
type KeepRule = (line: string, place: LinePlace) => boolean;

const BUN_TEST_PATTERN = /^bun\s+(run\s+)?test/;
// Bun prints one `(pass) <name>` record per passing test when stdout is not a terminal.
const PASSING_TEST_RECORD = /^\(pass\) /;
const ERROR_WARNING_PATTERN = /error|warning|warn/i;

const TEST_RUNNER_THRESHOLD_LINES = 200;
// The per-result cap of tool output is 30,000 UTF-8 bytes (`limitOutput`), so
// output up to this size reaches the model whole with room left for the
// result's own exit, landing, and notice lines. A line count hid the decisive
// middle of long logs whose lines are short.
const GENERIC_THRESHOLD_BYTES = 28_000;
// The compressed view stays well inside the same cap with its problem lines.
const GENERIC_HEAD_BYTES = 6_000;
const GENERIC_TAIL_BYTES = 12_000;

const keepAll: KeepRule = () => true;
const keepFailures: KeepRule = (line) => !PASSING_TEST_RECORD.test(line);
// The line that crosses into the tail window stays whole; `limitOutput` still bounds a huge one.
const keepHeadTailAndProblems: KeepRule = (line, { before, after }) =>
  before < GENERIC_HEAD_BYTES || after < GENERIC_TAIL_BYTES || ERROR_WARNING_PATTERN.test(line);

/** Whether ordinary command output of `bytes` UTF-8 bytes, newlines included,
 *  reaches the model without compression. */
export function shownUncompressed(bytes: number): boolean {
  return bytes <= GENERIC_THRESHOLD_BYTES;
}

const lineBytes = (line: string): number => Buffer.byteLength(line) + 1;
const linesBytes = (lines: readonly string[]): number => lines.reduce((sum, line) => sum + lineBytes(line), 0);

function omissionMarker(count: number, unit: ShellGap["unit"]): string {
  const noun = unit === "lines" ? (count === 1 ? "line" : "lines") : (count === 1 ? "character" : "characters");
  return `[... ${count} ${noun} omitted ...]`;
}

/** The rule for `view`. A capture gap means the output passed the capture
 *  window, which is far larger than the generic threshold. */
function keepRule(command: string, view: ShellLines, raw: boolean): KeepRule {
  if (raw) return keepAll;
  if (BUN_TEST_PATTERN.test(command)) {
    const lines = view.head.length + (view.gap?.unit === "lines" ? view.gap.count : 0) + view.tail.length;
    return lines <= TEST_RUNNER_THRESHOLD_LINES ? keepAll : keepFailures;
  }
  return view.gap === undefined && shownUncompressed(linesBytes(view.head) + linesBytes(view.tail)) ? keepAll : keepHeadTailAndProblems;
}

/** Renders the kept lines of `view` in order with one marker for each
 *  maximal dropped run. A line gap merges with the dropped runs that border
 *  it into one summed marker; a character gap always has its own marker.
 *  Every line is kept when `raw` is set. Test runners drop passing-test
 *  records from output of more than 200 real lines. Other commands keep
 *  output of at most 28,000 bytes whole, and above that a head, a tail, and
 *  error or warning lines. */
export function renderShellLines(command: string, view: ShellLines, raw: boolean): RenderedShellLines {
  const keep = keepRule(command, view, raw);
  const out: string[] = [];
  let dropped = 0;
  let compressed = false;
  const flush = (): void => {
    if (dropped > 0) out.push(omissionMarker(dropped, "lines"));
    dropped = 0;
  };
  let before = 0;
  const tailBytes = linesBytes(view.tail);
  let after = view.gap === undefined ? linesBytes(view.head) + tailBytes : Infinity;
  const visit = (line: string): void => {
    const size = lineBytes(line);
    after -= size;
    if (keep(line, { before, after })) {
      flush();
      out.push(line);
    } else {
      dropped++;
      compressed = true;
    }
    before += size;
  };
  for (const line of view.head) visit(line);
  // A character count bounds the gap's bytes from below, which only widens the head window.
  before += view.gap === undefined ? 0 : view.gap.unit === "characters" ? view.gap.count : Infinity;
  after = tailBytes;
  if (view.gap?.unit === "lines") {
    dropped += view.gap.count;
  } else if (view.gap) {
    flush();
    out.push(omissionMarker(view.gap.count, "characters"));
  }
  for (const line of view.tail) visit(line);
  flush();
  return { output: out.join("\n"), compressed };
}
