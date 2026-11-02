type SequenceState = "text" | "escape" | "escape_intermediate" | "csi" | "control_string" | "control_string_escape";

interface SequenceConsumer {
  push(text: string): void;
}

function createSequenceConsumer(emit: (char: string) => void): SequenceConsumer {
  let state: SequenceState = "text";
  let osc = false;

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
  return { push };
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
    push: (text) => {
      consumer.push(text);
      flush();
    },
    finish: () => {
      if (pendingCarriageReturn) output.push("\n");
      pendingCarriageReturn = false;
      flush();
    },
  };
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
