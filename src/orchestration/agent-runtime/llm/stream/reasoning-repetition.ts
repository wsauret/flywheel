import { Schema } from "effect";

/** The span of reasoning text whose compressibility decides a trip. A window
 *  of 4096 put ASCII-art reasoning within 1.2x of the threshold; 8192 keeps
 *  normal reasoning above 0.15 while a loop trips within about 8k chars of
 *  its start. */
const REPETITION_WINDOW_CHARS = 8192;
/** How many newly appended chars pass between two checks. One check costs
 *  tens of microseconds, so this bounds the cost to a small share of the
 *  stream's own work. */
const REPETITION_CHECK_EVERY_CHARS = 256;
/** Deflated bytes per raw byte at or below which the window is degenerate
 *  repetition. Normal reasoning, code, tables, and hex measured 0.15 or more,
 *  and the lowest normal window, in ASCII art, 0.176. A loop that counts up,
 *  such as "740,740,740, 741,741,741", deflates to about 0.085 to 0.088, so a
 *  threshold of 0.08 let it run for about 150k chars; 0.12 trips on it and
 *  keeps a margin of about 1.5x below normal reasoning. */
const REPETITION_RATIO_THRESHOLD = 0.12;

/** The reasoning of one response collapsed into repetition, so its attempt
 *  stops. `ratio` is the deflated share of the last `windowChars` chars, and
 *  `reasoningChars` counts every reasoning char the attempt streamed. */
export class DegenerateRepetitionError extends Schema.TaggedError<DegenerateRepetitionError>()("DegenerateRepetition", {
  ratio: Schema.Number,
  windowChars: Schema.Number,
  reasoningChars: Schema.Number,
  message: Schema.String,
}) {
  constructor(input: { ratio: number; windowChars: number; reasoningChars: number }) {
    super({ ...input, message: `model reasoning repeated itself (compression ratio ${input.ratio.toFixed(3)} over ${input.windowChars} chars)` });
    this.name = "DegenerateRepetitionError";
  }
}

interface ReasoningRepetitionDetector {
  observe(text: string): DegenerateRepetitionError | undefined;
}

/** Watches the reasoning text of one stream attempt. `observe` takes each
 *  reasoning delta in order and returns the error once a window of reasoning
 *  compresses below the threshold, and undefined before that. A check falls at
 *  every multiple of the check interval from the first full window on, also
 *  when one delta crosses several of them, so provider chunk sizes do not
 *  change which windows are checked. It keeps only the last window, not the
 *  attempt's whole reasoning. */
export function reasoningRepetitionDetector(): ReasoningRepetitionDetector {
  let tail = "";
  let reasoningChars = 0;
  let nextCheckAt = REPETITION_WINDOW_CHARS;
  return {
    observe(text) {
      const buffer = tail + text;
      const bufferStart = reasoningChars - tail.length;
      reasoningChars += text.length;
      for (; nextCheckAt <= reasoningChars; nextCheckAt += REPETITION_CHECK_EVERY_CHARS) {
        const end = nextCheckAt - bufferStart;
        const raw = Buffer.from(buffer.slice(end - REPETITION_WINDOW_CHARS, end), "utf8");
        const ratio = Bun.deflateSync(raw).byteLength / raw.byteLength;
        if (ratio <= REPETITION_RATIO_THRESHOLD) return new DegenerateRepetitionError({ ratio, windowChars: REPETITION_WINDOW_CHARS, reasoningChars });
      }
      tail = buffer.slice(-REPETITION_WINDOW_CHARS);
      return undefined;
    },
  };
}
