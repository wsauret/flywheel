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

/** Keeps the line at `position` among `total` real lines. */
type KeepRule = (line: string, position: number, total: number) => boolean;

const BUN_TEST_PATTERN = /^bun\s+(run\s+)?test/;
// Bun prints one `(pass) <name>` record per passing test when stdout is not a terminal.
const PASSING_TEST_RECORD = /^\(pass\) /;
const ERROR_WARNING_PATTERN = /error|warning|warn/i;

const GENERIC_HEAD = 30;
const GENERIC_TAIL = 40;
const GENERIC_THRESHOLD = 200;

const keepAll: KeepRule = () => true;
const keepFailures: KeepRule = (line) => !PASSING_TEST_RECORD.test(line);
const keepHeadTailAndProblems: KeepRule = (line, position, total) =>
  position < GENERIC_HEAD || position >= total - GENERIC_TAIL || ERROR_WARNING_PATTERN.test(line);

/** Whether ordinary command output of `lineCount` lines reaches the model without compression. */
export function shownUncompressed(lineCount: number): boolean {
  return lineCount <= GENERIC_THRESHOLD;
}

function omissionMarker(count: number, unit: ShellGap["unit"]): string {
  const noun = unit === "lines" ? (count === 1 ? "line" : "lines") : (count === 1 ? "character" : "characters");
  return `[... ${count} ${noun} omitted ...]`;
}

/** Renders the kept lines of `view` in order with one marker for each
 *  maximal dropped run. A line gap merges with the dropped runs that border
 *  it into one summed marker; a character gap always has its own marker.
 *  Output of at most 200 real lines, and every line when `raw` is set, is
 *  kept: test runners drop passing-test records, other commands keep a
 *  head, a tail, and error or warning lines. */
export function renderShellLines(command: string, view: ShellLines, raw: boolean): RenderedShellLines {
  const gapLines = view.gap?.unit === "lines" ? view.gap.count : 0;
  const total = view.head.length + gapLines + view.tail.length;
  const keep = raw || shownUncompressed(total) ? keepAll : BUN_TEST_PATTERN.test(command) ? keepFailures : keepHeadTailAndProblems;
  const out: string[] = [];
  let dropped = 0;
  let compressed = false;
  const flush = (): void => {
    if (dropped > 0) out.push(omissionMarker(dropped, "lines"));
    dropped = 0;
  };
  let position = 0;
  const visit = (line: string): void => {
    if (keep(line, position++, total)) {
      flush();
      out.push(line);
    } else {
      dropped++;
      compressed = true;
    }
  };
  for (const line of view.head) visit(line);
  if (view.gap?.unit === "lines") {
    dropped += view.gap.count;
    position += view.gap.count;
  } else if (view.gap) {
    flush();
    out.push(omissionMarker(view.gap.count, "characters"));
  }
  for (const line of view.tail) visit(line);
  flush();
  return { output: out.join("\n"), compressed };
}
