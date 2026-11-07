import { redactSecrets } from "./redact-secrets.js";

/** The code a Node or Bun system error names, such as `ENOENT`, or nothing
 *  when the error names none. */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(err: unknown): string {
  return redactSecrets(describe(err, new Set()));
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
  const cause = err.cause;
  if (cause === undefined || seen.has(cause) || (typeof cause === "object" && !(cause instanceof Error))) return own;
  const detail = describe(cause, seen);
  return detail.length === 0 || own.includes(detail) ? own : `${own}: ${detail}`;
}

export interface ErrorDetail {
  readonly kind: string
  readonly message: string
  readonly name?: string
  readonly constructorName?: string
  readonly stack?: string
  readonly value?: string
  readonly cause?: ErrorDetail
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
