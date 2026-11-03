import { redactSecrets } from "./redact-secrets.js";

/** The code a Node or Bun system error names, such as `ENOENT`, or nothing
 *  when the error names none. */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(err: unknown): string {
  return redactSecrets(describe(err, new Set()));
}

/** A diagnostic's detail as a log field: a plain record, such as a lane's end
 *  `{ kind: "closed", code: 1006 }`, stays data, and anything else is read as
 *  an error message. Read as text, a record logs as "[object Object]". */
export function diagnosticDetail(detail: unknown): DiagnosticDetail | undefined {
  if (detail === undefined) return undefined;
  return isPlainRecord(detail) ? detail : errorMessage(detail);
}

/** A diagnostic's detail as it is logged: a message, or a plain record. */
export type DiagnosticDetail = string | object;

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An error's own message, followed by each cause it names that the message
 *  does not already carry. Effect's typed errors and Node's `Error.cause` both
 *  leave the message generic and put the explanation in `cause`: "An error
 *  occurred during Open" says nothing, "An error occurred during Open: Failed
 *  to start server. Is port 41000 in use?" says what to fix. A cause that is
 *  an object but not an Error is a structured detail for `errorDetail`, not
 *  text for a message. */
function describe(err: unknown, seen: Set<unknown>): string {
  if (!(err instanceof Error)) return String(err);
  // Effect tagged errors and a bare `new Error()` can carry an empty message;
  // fall back to the error name so a caught error never renders as a blank log
  // line or (worse) a contentless error toast.
  const own = err.message.trim().length > 0 ? err.message : err.name;
  seen.add(err);
  const withMembers = err instanceof AggregateError ? withAggregateMembers(own, err.errors, seen) : own;
  const cause = err.cause;
  if (cause === undefined || seen.has(cause) || (typeof cause === "object" && !(cause instanceof Error))) return withMembers;
  const detail = describe(cause, seen);
  return detail.length === 0 || withMembers.includes(detail) ? withMembers : `${withMembers}: ${detail}`;
}

/** An AggregateError's message names none of its members, such as the owners
 *  that a shutdown barrier could not settle. Each member that the message
 *  does not already carry follows it. */
function withAggregateMembers(own: string, members: readonly unknown[], seen: Set<unknown>): string {
  const details: string[] = [];
  for (const member of members) {
    if (seen.has(member)) continue;
    const detail = describe(member, seen);
    if (detail.length > 0 && !own.includes(detail) && !details.includes(detail)) details.push(detail);
  }
  return details.length === 0 ? own : `${own}: ${details.join("; ")}`;
}

export interface ErrorDetail {
  readonly kind: string
  readonly message: string
  readonly name?: string
  readonly constructorName?: string
  readonly stack?: string
  readonly value?: string
  readonly cause?: ErrorDetail
  /** The members of an AggregateError. */
  readonly errors?: readonly ErrorDetail[]
}

export function errorDetail(err: unknown): ErrorDetail {
  const message = errorMessage(err)
  if (err instanceof Error) {
    return {
      kind: "error",
      message,
      name: err.name,
      constructorName: err.constructor.name,
      ...(err.stack ? { stack: redactSecrets(err.stack) } : {}),
      ...(err.cause !== undefined ? { cause: errorDetail(err.cause) } : {}),
      ...(err instanceof AggregateError && err.errors.length > 0 ? { errors: err.errors.map(errorDetail) } : {}),
    }
  }
  if (typeof err === "object" && err !== null) {
    return {
      kind: "object",
      message,
      constructorName: err.constructor.name,
      value: redactSecrets(safeStringify(err)),
    }
  }
  return { kind: typeof err, message, value: message }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
