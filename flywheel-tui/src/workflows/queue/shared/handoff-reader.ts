import type { ZodSchema, ZodError } from "zod";
import { errorMessage } from "../../../infra/error-message";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class HandoffMissingError extends Error {
  readonly name = "HandoffMissingError";
  constructor(readonly path: string) {
    super(`Handoff file not found: ${path}`);
  }
}

export class HandoffInvalidError extends Error {
  readonly name = "HandoffInvalidError";
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Handoff file invalid (${path}): ${detail}`);
  }
}

export class HandoffReadTimeoutError extends Error {
  readonly name = "HandoffReadTimeoutError";
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Handoff file read timed out after ${timeoutMs}ms: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReadHandoffOptions {
  /** Timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// readHandoff — generic reader for any handoff schema
// ---------------------------------------------------------------------------

export async function readHandoff<T>(
  path: string,
  schema: ZodSchema<T>,
  options?: ReadHandoffOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 5000;

  const result = await Promise.race([
    doRead(path, schema),
    timeoutPromise(path, timeoutMs),
  ]);

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function doRead<T>(path: string, schema: ZodSchema<T>): Promise<T> {
  const file = Bun.file(path);

  // Check existence
  const exists = await file.exists();
  if (!exists) {
    throw new HandoffMissingError(path);
  }

  // Read and parse JSON
  let raw: unknown;
  try {
    const text = await file.text();
    if (text.trim() === "") {
      throw new HandoffInvalidError(path, "JSON parse error: file is empty");
    }
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof HandoffInvalidError) throw err;
    throw new HandoffInvalidError(
      path,
      `JSON parse error: ${errorMessage(err)}`,
    );
  }

  // Validate against schema
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HandoffInvalidError(path, formatZodError(parsed.error));
  }

  return parsed.data;
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      if (issue.code === "unrecognized_keys") {
        return `Unrecognized key(s) at ${path}: ${(issue as any).keys.join(", ")}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function timeoutPromise(path: string, ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new HandoffReadTimeoutError(path, ms));
    }, ms);
  });
}
