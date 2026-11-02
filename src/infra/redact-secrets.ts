/** The mask every redaction boundary writes; prompt guidance names it so a model treats it as a marker, not content. */
export const SECRET_REPLACEMENT = "[redacted secret]"
interface RedactedFields {
  [key: string]: unknown
}

// Recognizes common standalone credential formats wherever they appear, even
// outside environment-variable assignments. Keep this list centralized because
// durable mutation diffs use the same classifier before retaining source bytes.
//
// Each anchor is a literal that every match of its pattern contains. A text
// without the anchor skips the pattern with one native substring check. The
// cost of that check increases with the positions where both end characters of
// the anchor occur, so the two end characters of each anchor are different.
// The AWS and Bearer patterns have no literal that every match contains, so
// they always run.
const SECRET_PATTERNS: readonly { readonly anchor?: string; readonly pattern: RegExp }[] = [
  { anchor: "sk-", pattern: /(?<![-\w])sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|ant-api\d{2}-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})\b/g },
  { anchor: "k_", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { anchor: "AIza", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { anchor: "eyJ", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { anchor: "gh", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { anchor: "github_pat_", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { anchor: "glpat-", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { anchor: "npm_", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { anchor: "pypi-", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/g },
  { anchor: "xo", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g },
  { anchor: "SG.", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi },
]

const PRIVATE_KEY_ANCHOR = "-----BEGIN "
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:(-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)|$)/g

// JavaScriptCore compiles a pattern once for each character width (Latin-1 and
// UTF-16) and each call shape. The compile samples the characters of the first
// text that it gets, and its scan then looks for the pattern character that is
// rarest in that sample. A short or unusual first text can choose a scan
// character that is dense in later text, and one 8 MB scan then takes about
// 20 ms instead of 0.3 ms. Thus the first redaction in a process sends each
// pattern this excerpt of typical tool output before the real text, in both
// widths and through the same function-replacement call that redaction uses.
// The choice then suits code, JSON, logs, and prose, whatever text the process
// redacts first. The warm-up runs on first use, so a process that never
// redacts does not pay for it at startup. It does not hold the choice if the
// engine compiles a pattern again later, and a text that is dense in the
// chosen character is still slow.
const SCAN_SAMPLE = '{"exit_code":0,"stdout":"src/infra/read-config.ts:12: export async function readConfig(path: string): Promise<Config> {\\n  const text = await file(path).text()\\n  return parse_toml(text)\\n}\\n"}'
let scanCharactersChosen = false

function chooseScanCharacters(): void {
  if (scanCharactersChosen) return
  scanCharactersChosen = true
  for (const sample of [SCAN_SAMPLE, `${SCAN_SAMPLE}\u2026`]) {
    for (const { pattern } of SECRET_PATTERNS) sample.replace(pattern, () => SECRET_REPLACEMENT)
    sample.replace(PRIVATE_KEY_PATTERN, () => SECRET_REPLACEMENT)
  }
}

type Completeness = "complete" | "prefix"

// The protocol package, and through it the web client and the editor host,
// reaches this module, and ARCH-PROTOCOL-003 lets it import only Bun-free modules.
// task-scheduling gives the task queue a turn with a Bun timer, so the
// synchronous forms drive the work with this copy of its runToCompletion.
function runToEnd<T>(work: Generator<void, T>): T {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}

// The secret patterns run over windows of about this many characters, so that
// one pattern over one window is the largest unit of work for most text.
const WINDOW_LENGTH = 1 << 17

// A secret-pattern match contains no character outside this class, except the
// whitespace after "Bearer". Each such character is a non-word character that
// is not "-", so the word boundaries and the look-behind before "sk-" see it
// the same as the edge of a window.
const SEPARATOR = /[^A-Za-z0-9._~+/=-]/g
const NON_WHITESPACE = /\S/g
const WHITESPACE = /\s/
const BEARER = /^bearer$/i

// Returns the end of the window that starts at `start`: the position after the
// first separator at or after `target` that no secret-pattern match can cross,
// or the end of the text. A whitespace run that follows "bearer" in any case
// can be inside a Bearer match, so the search skips that run. The walk back
// to the start of the run stops at `start`: the window boundary there was
// itself a separator that no match can cross, so the run does not follow
// "bearer". Replacement cannot make a run follow "bearer", because each
// replacement ends with "]" and never touches whitespace.
function windowEnd(text: string, start: number, target: number): number {
  let from = target
  for (;;) {
    SEPARATOR.lastIndex = from
    const found = SEPARATOR.exec(text)
    if (found === null) return text.length
    const position = found.index
    if (!WHITESPACE.test(found[0])) return position + 1
    let runStart = position
    while (runStart > start && WHITESPACE.test(text[runStart - 1] ?? "")) runStart -= 1
    if (runStart === start || !BEARER.test(text.slice(Math.max(0, runStart - 6), runStart))) return position + 1
    NON_WHITESPACE.lastIndex = position
    const runEnd = NON_WHITESPACE.exec(text)
    if (runEnd === null) return text.length
    from = runEnd.index
  }
}

// Each pattern runs on the window that the patterns before it already
// redacted. No match crosses a window boundary, so this gives the same bytes
// as each pattern over the whole text. A yield marks the point after each
// pattern in each window, so the result does not change where a caller gives
// the task queue a turn. The private-key pattern then runs over the whole
// text, because a key without an END delimiter extends to the end of the text.
// A text with no separator for megabytes, such as an unbroken base64 value,
// makes one large window.
function* replaceSecretsWork(text: string, completeness: Completeness, replacement: (match: string) => string): Generator<void, string> {
  chooseScanCharacters()
  const windows: string[] = []
  let changed = false
  for (let start = 0; start < text.length;) {
    const end = start + WINDOW_LENGTH >= text.length ? text.length : windowEnd(text, start, start + WINDOW_LENGTH)
    const window = start === 0 && end === text.length ? text : text.slice(start, end)
    let redacted = window
    for (const { anchor, pattern } of SECRET_PATTERNS) {
      if (anchor === undefined || redacted.includes(anchor)) redacted = redacted.replace(pattern, replacement)
      yield
    }
    changed ||= redacted !== window
    windows.push(redacted)
    start = end
  }
  let redacted = changed ? windows.join("") : text
  if (redacted.includes(PRIVATE_KEY_ANCHOR)) {
    redacted = redacted.replace(PRIVATE_KEY_PATTERN, (match, end: string | undefined) =>
      end !== undefined || completeness === "prefix" ? replacement(match) : match,
    )
  }
  yield
  return redacted
}

/**
 * The cooperative form of redactSecrets, with the same result. It yields after
 * each pattern in each window of the text. Run it with runInTaskSlices where one
 * text can hold megabytes of tool output, so that a long redaction does not hold
 * one host task.
 */
export function redactSecretsWork(text: string, options: { readonly completeness?: Completeness } = {}): Generator<void, string> {
  return replaceSecretsWork(text, options.completeness ?? "complete", () => SECRET_REPLACEMENT)
}

/**
 * Masks recognized credentials. Complete text requires a private-key END delimiter.
 * Use prefix completeness only for cut text: a recognized PRIVATE KEY BEGIN then
 * masks through end of text, because truncation can remove its END delimiter.
 */
export function redactSecrets(text: string, options: { readonly completeness?: Completeness } = {}): string {
  return runToEnd(redactSecretsWork(text, options))
}

const PRIVATE_KEY_END_ANCHOR = "-----END "
const PRIVATE_KEY_DELIMITER = /-----(?:BEGIN|END) (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/y
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g

/**
 * Redacts the start of a text: at least `length` characters, or the whole text,
 * which `whole` reports. The result is always the start of redactSecrets(text).
 * A cut follows a separator that no credential match and no private-key
 * delimiter crosses. A private key that the cut leaves open is masked through
 * the cut when an END delimiter after the cut closes it, as the whole text
 * masks it through that delimiter.
 */
export function redactSecretsPrefix(text: string, length: number) {
  let end = Math.min(length, text.length)
  for (;;) {
    end = end >= text.length ? text.length : windowEnd(text, 0, end)
    if (end === text.length) return { text: redactSecrets(text), whole: true }
    // A delimiter holds no "-----" between its ends, so only the last delimiter
    // that starts before the cut can cross it.
    const delimiter = Math.max(text.lastIndexOf(PRIVATE_KEY_ANCHOR, end - 1), text.lastIndexOf(PRIVATE_KEY_END_ANCHOR, end - 1))
    if (delimiter < 0) break
    PRIVATE_KEY_DELIMITER.lastIndex = delimiter
    const delimiterEnd = PRIVATE_KEY_DELIMITER.exec(text) === null ? delimiter : PRIVATE_KEY_DELIMITER.lastIndex
    if (delimiterEnd <= end) break
    end = delimiterEnd
  }
  PRIVATE_KEY_END.lastIndex = end
  const closedAfterCut = text.lastIndexOf(PRIVATE_KEY_ANCHOR, end - 1) >= 0 && PRIVATE_KEY_END.test(text)
  return { text: redactSecrets(text.slice(0, end), { completeness: closedAfterCut ? "prefix" : "complete" }), whole: false }
}

/**
 * Redacts one newline-joined console snapshot and returns one string per input entry.
 * Uses the same credentials and completeness rules as redactSecrets. Each match
 * becomes one mask followed by its original newlines, preserving entry boundaries,
 * including multiline, empty, and trailing lines. Inputs are not mutated or retained.
 * Pass prefix only when the console snapshot was truncated, not another channel.
 */
export function redactSecretEntries(entries: readonly string[], completeness: Completeness = "complete"): string[] {
  const lines = runToEnd(replaceSecretsWork(entries.join("\n"), completeness, (match) =>
    SECRET_REPLACEMENT + "\n".repeat(match.split("\n").length - 1),
  )).split("\n")
  let position = 0
  return entries.map((entry) => {
    const count = entry.split("\n").length
    const redacted = lines.slice(position, position + count).join("\n")
    position += count
    return redacted
  })
}

/** True when text contains a recognized credential value. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text
}

// Deep-walk a structured value, applying redactSecrets to each string leaf while
// preserving object/array structure and non-string scalars. Returns a new value;
// inputs are never mutated. Used to redact tool-call arguments where a secret can
// hide in any nested string field without stringifying the whole structure.
export function redactDeep<T>(value: T): T;
export function redactDeep<Value>(value: Value) {
  if (typeof value === "string") return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value !== null && typeof value === "object") {
    const out: RedactedFields = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
    return out
  }
  return value
}
