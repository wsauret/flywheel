/** argv is an external boundary: a malformed flag is an expected user error the
 *  CLI renders and exits non-zero on, not an internal defect. The per-flag
 *  helpers stay terse by throwing this one tagged error; `parseArgsResult`
 *  catches it at the parse boundary and hands callers a typed value instead of
 *  a bare throw. Any non-`CliArgsError` escaping a parser is a real bug and is
 *  left to propagate. */
export class CliArgsError extends Error {
  readonly _tag = "CliArgsError" as const
  constructor(message: string) {
    super(message)
    this.name = "CliArgsError"
  }
}

export type CliArgsResult<T> =
  | { readonly ok: true; readonly options: T }
  | { readonly ok: false; readonly error: CliArgsError }

/** Runs a throwing per-flag parser and surfaces argv errors as values. */
export function parseArgsResult<T>(parse: () => T): CliArgsResult<T> {
  try {
    return { ok: true, options: parse() }
  } catch (err) {
    if (err instanceof CliArgsError) return { ok: false, error: err }
    throw err
  }
}

export function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index]
  if (!value || value.startsWith("--")) throw new CliArgsError(`${flag} requires a value`)
  return value
}

export function parseTimeInput(value: string, flag: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) throw new CliArgsError(`${flag} requires epoch ms or an ISO 8601 timestamp`)
  return parsed
}
