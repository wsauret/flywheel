/** The mask every redaction boundary writes; prompt guidance names it so a model treats it as a marker, not content. */
export const SECRET_REPLACEMENT = "[redacted secret]"
interface RedactedFields {
  [key: string]: unknown
}

// Recognizes common standalone credential formats wherever they appear, even
// outside environment-variable assignments. Keep this list centralized because
// durable mutation diffs use the same classifier before retaining source bytes.
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?<![-\w])sk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|ant-api\d{2}-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
]

const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:(-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)|$)/g

function replaceSecrets(text: string, completeness: "complete" | "prefix", replacement: (match: string) => string): string {
  let redacted = text
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted.replace(PRIVATE_KEY_PATTERN, (match, end: string | undefined) =>
    end !== undefined || completeness === "prefix" ? replacement(match) : match,
  )
}

/**
 * Masks recognized credentials. Complete text requires a private-key END delimiter.
 * Use prefix completeness only for cut text: a recognized PRIVATE KEY BEGIN then
 * masks through end of text, because truncation can remove its END delimiter.
 */
export function redactSecrets(text: string, options: { readonly completeness?: "complete" | "prefix" } = {}): string {
  return replaceSecrets(text, options.completeness ?? "complete", () => SECRET_REPLACEMENT)
}

/**
 * Redacts one newline-joined console snapshot and returns one string per input entry.
 * Uses the same credentials and completeness rules as redactSecrets. Each match
 * becomes one mask followed by its original newlines, preserving entry boundaries,
 * including multiline, empty, and trailing lines. Inputs are not mutated or retained.
 * Pass prefix only when the console snapshot was truncated, not another channel.
 */
export function redactSecretEntries(entries: readonly string[], completeness: "complete" | "prefix" = "complete"): string[] {
  const lines = replaceSecrets(entries.join("\n"), completeness, (match) =>
    SECRET_REPLACEMENT + "\n".repeat(match.split("\n").length - 1),
  ).split("\n")
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
