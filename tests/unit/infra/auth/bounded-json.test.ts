import { describe, expect, it } from "bun:test";
import { BoundedJsonError, readBoundedJson } from "../../../../src/infra/auth/bounded-json.js";

async function errorFrom(response: Response, maxBytes: number): Promise<BoundedJsonError> {
  const error = await readBoundedJson(response, maxBytes).then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(BoundedJsonError);
  if (!(error instanceof BoundedJsonError)) throw new Error("Expected BoundedJsonError");
  return error;
}

describe("readBoundedJson", () => {
  it("parses a valid JSON response", async () => {
    await expect(readBoundedJson(Response.json({ value: [1, true, null] }), 128)).resolves.toEqual({ value: [1, true, null] });
  });

  it("rejects a missing body with a fixed safe error", async () => {
    const error = await errorFrom(new Response(null), 128);
    expect(error.kind).toBe("missing_body");
    expect(error.message).toBe("JSON response body is missing");
  });

  it("rejects malformed JSON without including body text", async () => {
    const body = "secret malformed body";
    const error = await errorFrom(new Response(body), 128);
    expect(error.kind).toBe("malformed_json");
    expect(error.message).toBe("JSON response body is malformed");
    expect(error.message).not.toContain(body);
  });

  it("rejects an oversized declared length before reading", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const error = await errorFrom(new Response(body, { headers: { "content-length": "129" } }), 128);
    expect(error.kind).toBe("body_too_large");
    expect(error.message).toBe("JSON response body exceeds the size limit");
  });

  it("cancels and rejects a streamed body that crosses the bound", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await errorFrom(new Response(body), 128);
    expect(error.kind).toBe("body_too_large");
    expect(cancelled).toBe(true);
  });
});
