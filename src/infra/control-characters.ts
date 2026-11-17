type SequenceState = "text" | "escape" | "escape_intermediate" | "csi" | "control_string" | "control_string_escape";

interface SequenceConsumerState {
  readonly state: SequenceState;
  /** The open control string is an OSC string, which a BEL also ends. */
  readonly osc: boolean;
}

interface SequenceConsumer {
  push(text: string): void;
  /** Whether no escape sequence or control string is open. */
  inText(): boolean;
  state(): SequenceConsumerState;
}

function createSequenceConsumer(emit: (char: string) => void, from: SequenceConsumerState = { state: "text", osc: false }): SequenceConsumer {
  let { state, osc } = from;

  const push = (text: string): void => {
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (state === "csi") {
        if (code >= 0x40 && code <= 0x7e) state = "text";
        continue;
      }
      if (state === "control_string") {
        if ((osc && char === "\u0007") || char === "\u009c") state = "text";
        else if (char === "\u001b") state = "control_string_escape";
        continue;
      }
      if (state === "control_string_escape") {
        if (char === "\\" || char === "\u009c" || (osc && char === "\u0007")) state = "text";
        else if (char !== "\u001b") state = "control_string";
        continue;
      }
      if (state === "escape_intermediate") {
        if (code >= 0x30 && code <= 0x7e) state = "text";
        else if (code < 0x20 || code > 0x2f) state = "text";
        continue;
      }
      if (state === "escape") {
        if (char === "[") state = "csi";
        else if (char === "P" || char === "X" || char === "]" || char === "^" || char === "_") {
          state = "control_string";
          osc = char === "]";
        } else if (code >= 0x20 && code <= 0x2f) state = "escape_intermediate";
        else state = "text";
        continue;
      }
      if (char === "\u001b") state = "escape";
      else if (char === "\u009b") state = "csi";
      else if (char === "\u0090" || char === "\u0098" || char === "\u009d" || char === "\u009e" || char === "\u009f") {
        state = "control_string";
        osc = char === "\u009d";
      } else emit(char);
    }
  };
  return { push, inText: () => state === "text", state: () => ({ state, osc }) };
}

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 31 || code === 127;
}

export function isPrintableText(raw: string): boolean {
  if (raw.length === 0) return false;
  for (const char of raw) {
    if (isControlCharacter(char)) return false;
  }
  return true;
}

// Text built here is joined from an array, never appended one character at a
// time: per-character `+=` leaves a rope of one node per character that the
// engine flattens only when the string is first read, and a block nobody reads
// (an unwatched session's output) would retain every node.
export function stripControlCharacters(raw: string): string {
  const clean: string[] = [];
  for (const char of raw) {
    if (!isControlCharacter(char)) clean.push(char);
  }
  return clean.join("");
}

export function stripAnsiEscapes(raw: string): string {
  const clean: string[] = [];
  createSequenceConsumer((char) => { clean.push(char); }).push(raw);
  return clean.join("");
}

/** Every character the streaming sanitizer does not pass through unchanged:
 *  C0 controls except tab and newline (carriage return and escape included),
 *  DEL, and the C1 controls. */
// oxlint-disable-next-line no-control-regex -- boundary: this pattern exists to find the control characters that external text carries
const SANITIZED_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

export interface StreamingSanitizer {
  push(text: string): void;
  finish(): void;
}

/** Creates an external-text sanitizer that preserves escape and carriage-return state across pushes. */
export function createStreamingSanitizer(emit: (text: string) => void): StreamingSanitizer {
  let pendingCarriageReturn = false;
  const output: string[] = [];
  const consumer = createSequenceConsumer((char) => {
    if (pendingCarriageReturn) {
      output.push("\n");
      pendingCarriageReturn = false;
      if (char === "\n") return;
    }
    if (char === "\r") {
      pendingCarriageReturn = true;
      return;
    }
    const code = char.charCodeAt(0);
    if (char === "\n" || char === "\t" || (code > 31 && (code < 127 || code > 159))) output.push(char);
  });
  const flush = (): void => {
    if (output.length === 0) return;
    emit(output.join(""));
    output.length = 0;
  };
  return {
    // Almost all external text holds no control character, so a chunk read
    // in the text state with no carriage return pending passes through whole,
    // and only the part from its first control character walks the state
    // machine one character at a time.
    push: (text) => {
      const first = pendingCarriageReturn || !consumer.inText() ? 0 : text.search(SANITIZED_CHARACTER);
      if (first === -1) {
        if (text.length > 0) emit(text);
        return;
      }
      if (first > 0) output.push(text.slice(0, first));
      consumer.push(first > 0 ? text.slice(first) : text);
      flush();
    },
    finish: () => {
      if (pendingCarriageReturn) output.push("\n");
      pendingCarriageReturn = false;
      flush();
    },
  };
}

/** Bidi formatting controls: they reorder the rest of a row's text around them,
 *  so a name or detail carrying one can present as text it does not contain.
 *  Other `Cf` characters stay: a zero-width joiner is part of an emoji. */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const PRESENTATION_BLANK = /[\p{Cc}\p{Zl}\p{Zp}\s]/u;

/** Where a presentation sanitizer stands in its input: the escape sequence
 *  that is open, and whether a blank run waits for the character after it. */
export interface PresentationSanitizerState {
  readonly sequence: SequenceConsumerState;
  readonly started: boolean;
  readonly blank: boolean;
}

/** The sanitizer of `sanitizePresentationText` for text that arrives in
 *  pieces, so a streaming row reads each character once. */
export interface PresentationTextSanitizer {
  /** Reads one more raw piece and returns the sanitized text it adds. A
   *  trailing blank run is held until a character follows it, which trims
   *  the end. */
  push(raw: string): string;
  /** Where the sanitizer stands now, so a new sanitizer can resume from here. */
  state(): PresentationSanitizerState;
}

export function createPresentationTextSanitizer(from?: PresentationSanitizerState): PresentationTextSanitizer {
  let started = from?.started ?? false;
  let blank = from?.blank ?? false;
  const added: string[] = [];
  const consumer = createSequenceConsumer((char) => {
    if (BIDI_CONTROL.test(char)) return;
    if (PRESENTATION_BLANK.test(char)) {
      blank = true;
      return;
    }
    if (blank && started) added.push(" ");
    blank = false;
    started = true;
    added.push(char);
  }, from?.sequence);
  return {
    push: (raw) => {
      consumer.push(raw);
      const text = added.join("");
      added.length = 0;
      return text;
    },
    state: () => ({ sequence: consumer.state(), started, blank }),
  };
}

/** Reduce one presentation string to a single logical display line. ANSI, OSC,
 *  and C1 escape sequences go first, because their bytes only read as controls
 *  as a sequence; bidi controls go next; the remaining C0/C1 controls, line and
 *  paragraph separators, and every other whitespace run then fold to one space,
 *  and the ends are trimmed. Ordinary punctuation is untouched, so a
 *  search-style detail still reads exactly as written. */
export function sanitizePresentationText(raw: string): string {
  return createPresentationTextSanitizer().push(raw);
}

/** Normalize text crossing an external boundary (subprocess output, file bytes
 *  surfaced for display): drop ANSI escape sequences, fold carriage returns
 *  into newlines, and strip the remaining C0/C1 controls (keeping \n and \t).
 *  Raw ESC bytes in a rendered cell desync the terminal's cursor from the
 *  renderer's frame diff, ghosting stale cell fragments; in model content they
 *  are token noise. */
export function sanitizeExternalText(raw: string): string {
  const clean: string[] = [];
  const sanitizer = createStreamingSanitizer((text) => { clean.push(text); });
  sanitizer.push(raw);
  sanitizer.finish();
  return clean.join("");
}
