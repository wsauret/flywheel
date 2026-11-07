import { Schema } from "effect";
import { asRecord, isRecord } from "../record.js";
import { redactSecrets } from "../redact-secrets.js";

interface DiagnosticHeaders {
  [name: string]: string;
}

interface UnknownFields {
  [key: string]: unknown;
}

export interface ProviderErrorDiagnostic {
  name?: string;
  message: string;
  status?: number;
  code?: string;
  type?: string;
  kind?: string;
  errno?: string;
  syscall?: string;
  address?: string;
  port?: number;
  retryDelayMs?: number;
  headers?: DiagnosticHeaders;
  /** OpenRouter's verbatim upstream-provider error (`error.metadata.raw`);
   *  without it a mirrored Anthropic/Google failure reads as a bare
   *  "Provider returned error" (pi `openai-completions.ts:600-603`). */
  upstream?: string;
  cause?: ProviderErrorDiagnostic;
  errors?: ProviderErrorDiagnostic[];
}

/** The strict audit decode of `ProviderErrorDiagnostic`. `Schema.Codec<T>` accepts a schema that omits an
 * optional key, and the store gate then refuses a fact that carries it, so `satisfies` requires one field
 * for each key of the interface. */
export const ProviderErrorDiagnosticSchema: Schema.Codec<ProviderErrorDiagnostic> = Schema.suspend((): Schema.Codec<ProviderErrorDiagnostic> =>
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    message: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    code: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.String),
    errno: Schema.optionalKey(Schema.String),
    syscall: Schema.optionalKey(Schema.String),
    address: Schema.optionalKey(Schema.String),
    port: Schema.optionalKey(Schema.Number),
    retryDelayMs: Schema.optionalKey(Schema.Number),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    upstream: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(ProviderErrorDiagnosticSchema),
    errors: Schema.optionalKey(Schema.mutable(Schema.Array(ProviderErrorDiagnosticSchema))),
  } satisfies { [Key in keyof ProviderErrorDiagnostic]-?: Schema.Top })
);

const HEADER_NAMES = [
  "x-request-id",
  "request-id",
  "cf-ray",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
] as const;

export function summarizeProviderError(error: unknown): ProviderErrorDiagnostic {
  return summarize(error, 0);
}

function summarize(error: unknown, depth: number): ProviderErrorDiagnostic {
  const record = asRecord(error);
  const diagnostic: ProviderErrorDiagnostic = {
    message: redactSecrets(error instanceof Error ? error.message : stringProperty(record, "message") ?? String(error)),
  };

  const name = error instanceof Error ? error.name : stringProperty(record, "name");
  if (name) diagnostic.name = redactSecrets(name);

  const status = numberProperty(record, "status");
  if (status !== undefined) diagnostic.status = status;

  for (const key of ["code", "type", "kind", "errno", "syscall", "address"] as const) {
    const value = stringProperty(record, key);
    if (value) diagnostic[key] = redactSecrets(value);
  }

  const port = numberProperty(record, "port");
  if (port !== undefined) diagnostic.port = port;

  const retryDelayMs = numberProperty(record, "retryDelayMs");
  if (retryDelayMs !== undefined) diagnostic.retryDelayMs = retryDelayMs;

  const headers = summarizeHeaders(record?.headers);
  if (headers) diagnostic.headers = headers;

  const metadata = asRecord(asRecord(record?.error)?.metadata ?? record?.metadata);
  const upstreamRaw = stringProperty(metadata, "raw");
  if (upstreamRaw) diagnostic.upstream = redactSecrets(upstreamRaw.slice(0, 500));

  if (depth < 5) {
    const cause = error instanceof Error ? error.cause : record?.cause;
    if (cause !== undefined) diagnostic.cause = summarize(cause, depth + 1);

    if (error instanceof AggregateError) {
      diagnostic.errors = error.errors.slice(0, 3).map((item) => summarize(item, depth + 1));
    }
  }

  return diagnostic;
}

function stringProperty(record: UnknownFields | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function numberProperty(record: UnknownFields | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarizeHeaders(headers: unknown): DiagnosticHeaders | undefined {
  if (!hasHeaderGetter(headers)) return undefined;
  const result: DiagnosticHeaders = {};
  for (const name of HEADER_NAMES) {
    const value = headers.get(name);
    if (value) result[name] = redactSecrets(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function hasHeaderGetter(value: unknown): value is { get(name: string): string | null } {
  return isRecord(value) && typeof value.get === "function";
}

