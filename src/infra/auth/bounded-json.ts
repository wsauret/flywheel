export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type BoundedJsonErrorKind = "missing_body" | "malformed_json" | "body_too_large";

function errorMessage(kind: BoundedJsonErrorKind): string {
  if (kind === "missing_body") return "JSON response body is missing";
  if (kind === "malformed_json") return "JSON response body is malformed";
  return "JSON response body exceeds the size limit";
}

export class BoundedJsonError extends Error {
  readonly _tag = "BoundedJsonError" as const;

  constructor(readonly kind: BoundedJsonErrorKind) {
    super(errorMessage(kind));
    this.name = "BoundedJsonError";
  }
}

/** Reads and parses one response body without retaining more than `maxBytes`.
 * Missing, malformed, and oversized bodies reject with fixed safe errors that
 * never include response content. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<JsonValue> {
  return (await readBoundedJsonWithByteLength(response, maxBytes)).value;
}

/** Reads bounded JSON and reports the accepted raw byte count for aggregate budgets. */
export async function readBoundedJsonWithByteLength(
  response: Response,
  maxBytes: number,
): Promise<{ readonly value: JsonValue; readonly byteLength: number }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) throw new BoundedJsonError("body_too_large");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new BoundedJsonError("missing_body");

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new BoundedJsonError("body_too_large");
    }
    chunks.push(next.value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), byteLength };
  } catch {
    throw new BoundedJsonError("malformed_json");
  }
}
