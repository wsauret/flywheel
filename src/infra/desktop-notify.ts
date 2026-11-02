import { redactSecrets } from "./redact-secrets.js"

const MAX_BODY = 200

/** Builds the terminal bytes without writing them. The production wrapper writes
 * to a real TTY, so byte-level escaping and injection invariants cannot be
 * observed through that I/O boundary. */
export function buildOsc777(title: string, body: string, opts: { tmux: boolean }): string {
  const osc777 = `\x1b]777;notify;${sanitizeField(title)};${sanitizeField(truncate(body))}\x07`
  return opts.tmux ? `\x1bPtmux;\x1b${osc777}\x1b\\` : osc777
}

// Emit the escape to the user's real terminal. A disabled policy skips the target;
// a missing TTY or write failure is a failed presentation that callers can settle.
export function notifyDesktop(title: string, body: string, options: { readonly enabled?: boolean } = {}): PresentationResult {
  if (options.enabled === false) return { kind: "skipped-by-policy" }
  if (!process.stdout.isTTY) return { kind: "failed", error: "Desktop notification requires a presentation-capable TTY" }
  try {
    const tmux = Boolean(process.env.TMUX || process.env.STY)
    process.stdout.write(buildOsc777(title, body, { tmux }))
    return { kind: "accepted" }
  } catch (cause) {
    return { kind: "failed", error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export type PresentationResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "skipped-by-policy" }
  | { readonly kind: "failed"; readonly error: string }

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > MAX_BODY ? `${normalized.slice(0, MAX_BODY - 1)}…` : normalized
}

// Redact secrets, then neutralize OSC field delimiters and control bytes so run
// output cannot leak a key or break/inject into the escape we emit to the user's
// real terminal. OSC 777 is positional (title/body split on `;`, terminated by
// BEL/ST), so this is a write-side invariant on a sequence WE construct: strict,
// not tolerant.
function sanitizeField(text: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching C0 controls + ST
  return redactSecrets(text).replace(/[\x00-\x1f\x9c;]/g, " ").trim()
}
