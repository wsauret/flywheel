type JsonObject = { [key in string]: unknown };
interface DecodedStringFields { [key: string]: string }
type ParsedSkippedValue =
  | { readonly status: "parsed"; readonly value: unknown }
  | { readonly status: "failed" };
export const MAX_STREAMING_TOOL_INPUT_BYTES = 4 * 1024 * 1024;

const JSON_ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

type DecoderState =
  | "start"
  | "key_or_end"
  | "key"
  | "colon"
  | "value"
  | "string_value"
  | "skip_value"
  | "comma_or_end"
  | "done"
  | "failed";

export interface DecodedStringAppend {
  /** Newly decoded text, keyed by the exact fields declared by the display. */
  additions: Readonly<DecodedStringFields>;
  /** Declared fields whose closing quote was accepted in this append. */
  completedFields: readonly string[];
  /** Whether the complete top-level object is now authoritative. */
  completedObject: boolean;
  /** UTF-8 source bytes accepted by the decoder. */
  acceptedBytes: number;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declared name of a decoded field path: `edits.2.old_string` is declared as `edits.*.old_string`. */
export function declaredFieldName(path: string): string {
  return path.replace(/\.\d+\./, ".*.");
}

/**
 * Incrementally decodes top-level JSON string fields. A declared boolean,
 * object, or list field is exposed whole once its value completes. A declared
 * `list.*.field` streams the string `field` of each object item of the
 * top-level list `list`, under the path `list.<index>.field`.
 *
 * The decoder accepts each source character once, preserves escape state across
 * appends, and stops exposing data after malformed top-level input.
 */
export class TopLevelJsonStringDecoder {
  private state: DecoderState = "start";
  private key = "";
  private valueChunks: string[] = [];
  private escaped = false;
  private unicode = "";
  private pendingHighSurrogate = "";
  private skipStack: string[] = [];
  private skipQuote = false;
  private skipEscaped = false;
  private skippedChunks: string[] = [];
  private decodedFields: JsonObject = {};
  private readonly declaredFields: ReadonlySet<string>;
  /** Item fields that stream, by the top-level list that holds the items. */
  private readonly itemFields = new Map<string, Set<string>>();
  /** Scan of a top-level list whose item fields stream; undefined outside one. */
  private list?: { item: number; phase: "key" | "value"; itemKey: string; text?: { readonly kind: "key" | "value" | "other"; chunks: string[] } };
  private acceptedByteTotal = 0;

  constructor(fields: readonly string[], private readonly maxInputBytes = MAX_STREAMING_TOOL_INPUT_BYTES) {
    this.declaredFields = new Set(fields);
    for (const field of fields) {
      const [list, item] = field.split(".*.");
      if (list !== undefined && item !== undefined) this.itemFields.set(list, (this.itemFields.get(list) ?? new Set()).add(item));
    }
  }

  get fields(): Readonly<JsonObject> {
    return this.decodedFields;
  }

  get acceptedBytes(): number {
    return this.acceptedByteTotal;
  }

  get failed(): boolean {
    return this.state === "failed";
  }

  get completed(): boolean {
    return this.state === "done";
  }

  field(name: string): string | boolean | undefined {
    if (!this.declaredFields.has(declaredFieldName(name))) return undefined;
    if (this.state === "string_value" && this.key === name) return this.valueChunks.join("");
    const value = this.decodedFields[name];
    return typeof value === "string" || typeof value === "boolean" ? value : undefined;
  }

  append(source: string): DecodedStringAppend {
    if (this.state === "failed" || this.state === "done") return { additions: {}, completedFields: [], completedObject: this.completed, acceptedBytes: 0 };
    const sourceBytes = Buffer.byteLength(source);
    if (this.acceptedByteTotal + sourceBytes > this.maxInputBytes) {
      this.fail();
      return { additions: {}, completedFields: [], completedObject: false, acceptedBytes: 0 };
    }
    this.acceptedByteTotal += sourceBytes;
    const additions: DecodedStringFields = {};
    const completedFields: string[] = [];

    const emit = (text: string): void => {
      if (!this.declaredFields.has(this.key)) return;
      this.valueChunks.push(text);
      additions[this.key] = (additions[this.key] ?? "") + text;
    };

    for (const char of source) {
      if (this.state === "failed" || this.state === "done") break;
      if (this.consumeWhitespace(char)) continue;

      switch (this.state) {
        case "start":
          this.state = char === "{" ? "key_or_end" : "failed";
          break;
        case "key_or_end":
          if (char === "}") this.state = "done";
          else if (char === '"') {
            this.key = "";
            this.state = "key";
          } else this.state = "failed";
          break;
        case "key":
          this.consumeStringCharacter(char, (text) => { this.key += text; }, "colon");
          break;
        case "colon":
          this.state = char === ":" ? "value" : "failed";
          break;
        case "value":
          if (char === '"') {
            this.valueChunks = [];
            this.resetEscape();
            this.state = "string_value";
          } else {
            this.beginSkippedValue(char);
          }
          break;
        case "string_value":
          if (this.consumeStringCharacter(char, emit, "comma_or_end")) {
            this.flushPendingSurrogate(emit);
            if (this.declaredFields.has(this.key)) {
              this.decodedFields[this.key] = this.valueChunks.join("");
              completedFields.push(this.key);
            }
          }
          break;
        case "skip_value":
          if (this.list && this.consumeListCharacter(char, additions, completedFields)) {
            this.skippedChunks.push(char);
            break;
          }
          this.consumeSkippedValue(char, (value) => {
            this.list = undefined;
            if ((typeof value === "boolean" || isJsonObject(value) || Array.isArray(value)) && this.declaredFields.has(this.key)) {
              this.decodedFields[this.key] = value;
              completedFields.push(this.key);
            }
          });
          break;
        case "comma_or_end":
          if (char === ",") this.state = "key_or_end";
          else if (char === "}") this.state = "done";
          else this.state = "failed";
          break;
      }
    }

    if (this.state === "failed") {
      this.fail();
      return { additions: {}, completedFields: [], completedObject: false, acceptedBytes: sourceBytes };
    }
    return { additions, completedFields, completedObject: this.completed, acceptedBytes: sourceBytes };
  }

  private consumeWhitespace(char: string): boolean {
    return (this.state === "start" || this.state === "key_or_end" || this.state === "colon"
      || this.state === "value" || this.state === "comma_or_end")
      && (char === " " || char === "\n" || char === "\r" || char === "\t");
  }

  private consumeStringCharacter(char: string, emit: (text: string) => void, next: DecoderState): boolean {
    if (this.unicode.length > 0) {
      if (!/^[0-9a-fA-F]$/.test(char)) {
        this.state = "failed";
        return false;
      }
      this.unicode += char;
      if (this.unicode.length === 5) {
        this.emitCodeUnit(Number.parseInt(this.unicode.slice(1), 16), emit);
        this.unicode = "";
        this.escaped = false;
      }
      return false;
    }
    if (this.escaped) {
      if (char === "u") {
        this.unicode = "u";
        return false;
      }
      const decoded = JSON_ESCAPES.get(char);
      if (decoded === undefined) this.state = "failed";
      else {
        this.flushPendingSurrogate(emit);
        emit(decoded);
        this.escaped = false;
      }
      return false;
    }
    if (char === "\\") {
      this.escaped = true;
      return false;
    }
    if (char === '"') {
      this.state = next;
      return true;
    }
    if (char.charCodeAt(0) < 0x20) {
      this.state = "failed";
      return false;
    }
    this.flushPendingSurrogate(emit);
    emit(char);
    return false;
  }

  private emitCodeUnit(codeUnit: number, emit: (text: string) => void): void {
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      this.flushPendingSurrogate(emit);
      this.pendingHighSurrogate = String.fromCharCode(codeUnit);
      return;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && this.pendingHighSurrogate) {
      emit(this.pendingHighSurrogate + String.fromCharCode(codeUnit));
      this.pendingHighSurrogate = "";
      return;
    }
    this.flushPendingSurrogate(emit);
    emit(String.fromCharCode(codeUnit));
  }

  private flushPendingSurrogate(emit: (text: string) => void): void {
    if (!this.pendingHighSurrogate) return;
    emit(this.pendingHighSurrogate);
    this.pendingHighSurrogate = "";
  }

  private resetEscape(): void {
    this.escaped = false;
    this.unicode = "";
    this.pendingHighSurrogate = "";
  }

  private beginSkippedValue(char: string): void {
    if (char === "[" && this.itemFields.has(this.key)) this.list = { item: -1, phase: "key", itemKey: "" };
    if (char === "{" || char === "[") {
      this.skipStack = [char];
      this.skippedChunks = [char];
      this.skipQuote = false;
      this.skipEscaped = false;
      this.state = "skip_value";
    } else if (char === "," || char === "}") {
      this.state = "failed";
    } else {
      this.skipStack = [];
      this.skippedChunks = [char];
      this.state = "skip_value";
    }
  }

  /** Decodes the strings of a streamed list and tracks which item and key they belong to. Returns
   *  true for a character of a string, which the skipped-value scan then only records; brackets
   *  and separators stay with that scan. Depth 1 is inside the list, depth 2 inside an item. */
  private consumeListCharacter(char: string, additions: DecodedStringFields, completedFields: string[]): boolean {
    // SAFETY: the caller checked that a list scan is active.
    const list = this.list!;
    const text = list.text;
    if (text) {
      const path = `${this.key}.${list.item}.${list.itemKey}`;
      const emit = (decoded: string): void => {
        text.chunks.push(decoded);
        if (text.kind === "value") additions[path] = (additions[path] ?? "") + decoded;
      };
      if (!this.consumeStringCharacter(char, emit, "skip_value")) return true;
      this.flushPendingSurrogate(emit);
      if (text.kind === "key") list.itemKey = text.chunks.join("");
      if (text.kind === "value") {
        this.decodedFields[path] = text.chunks.join("");
        completedFields.push(path);
      }
      list.text = undefined;
      return true;
    }
    const depth = this.skipStack.length;
    if (char === '"') {
      this.resetEscape();
      const streamed = depth === 2 && list.phase === "value" && this.itemFields.get(this.key)?.has(list.itemKey) === true;
      list.text = { kind: depth === 2 && list.phase === "key" ? "key" : streamed ? "value" : "other", chunks: [] };
      return true;
    }
    if (char === "{" && depth === 1) {
      list.item += 1;
      list.phase = "key";
    } else if (depth === 2 && (char === ":" || char === ",")) {
      list.phase = char === ":" ? "value" : "key";
    }
    return false;
  }

  private consumeSkippedValue(char: string, complete: (value: unknown) => void): void {
    if (this.skipStack.length === 0 && (char === "," || char === "}")) {
      const parsed = this.parseSkippedValue();
      if (parsed.status === "failed") {
        this.state = "failed";
        return;
      }
      complete(parsed.value);
      this.skippedChunks = [];
      this.state = char === "," ? "key_or_end" : "done";
      return;
    }
    this.skippedChunks.push(char);
    if (this.skipQuote) {
      if (this.skipEscaped) this.skipEscaped = false;
      else if (char === "\\") this.skipEscaped = true;
      else if (char === '"') this.skipQuote = false;
      return;
    }
    if (char === '"') {
      if (this.skipStack.length === 0) this.state = "failed";
      else this.skipQuote = true;
    } else if (char === "{" || char === "[") this.skipStack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (this.skipStack.at(-1) !== expected) {
        this.state = "failed";
        return;
      }
      this.skipStack.pop();
      if (this.skipStack.length === 0) {
        const parsed = this.parseSkippedValue();
        if (parsed.status === "failed") this.state = "failed";
        else {
          complete(parsed.value);
          this.skippedChunks = [];
          this.state = "comma_or_end";
        }
      }
    }
  }

  private parseSkippedValue(): ParsedSkippedValue {
    try {
      return { status: "parsed", value: JSON.parse(this.skippedChunks.join("")) };
    } catch {
      return { status: "failed" };
    }
  }

  private fail(): void {
    this.state = "failed";
    this.list = undefined;
    this.valueChunks = [];
    this.skippedChunks = [];
    this.decodedFields = {};
  }
}

