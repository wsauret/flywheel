import { Result, Schema, SchemaAST } from "effect";

interface SchemaIssue {
  path: ReadonlyArray<string | number>;
  message: string;
}

type SchemaParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: SchemaIssue[]; message: string } };

const PATH_PATTERN = /at \[(?<path>[^\]]*)\]/;

export function safeParse<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  value: unknown,
): SchemaParseResult<S["Type"]> {
  return parse(schema, value, { onExcessProperty: "error" });
}

export function safeParseStrip<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  value: unknown,
): SchemaParseResult<S["Type"]> {
  return parse(schema, value);
}

export function parseSchema<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
}

export function parseSchemaStrip<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(value);
}

function parse<S extends Schema.Decoder<unknown, never>>(
  schema: S,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): SchemaParseResult<S["Type"]> {
  const result = Schema.decodeUnknownResult(schema, options)(value);
  if (Result.isSuccess(result)) {
    return { success: true, data: result.success };
  }

  const message = result.failure.message;
  return {
    success: false,
    error: {
      issues: [{ path: parsePath(message), message }],
      message,
    },
  };
}

function parsePath(message: string): ReadonlyArray<string | number> {
  const match = PATH_PATTERN.exec(message);
  if (!match?.groups?.path) return [];

  try {
    const parsed: unknown = JSON.parse(`[${match.groups.path}]`);
    return Array.isArray(parsed) && parsed.every(isPathSegment) ? parsed : [];
  } catch {
    return [];
  }
}

function isPathSegment(segment: unknown): segment is string | number {
  return typeof segment === "string" || typeof segment === "number";
}
