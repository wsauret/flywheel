import { describe, expect, test } from "bun:test";
import { RetryingTransport, type RetryClock, type RetryPolicy } from "./retrying-transport.ts";
import type { HttpRequest, HttpResponse, Transport } from "./transport.ts";

const POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };
const NOW = Date.parse("2026-03-01T12:00:00Z");

type Step = HttpResponse | Error;

function respond(status: number, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: "" };
}

/** A transport that plays back `steps` in order and counts the requests it saw. */
function scripted(steps: Step[]): Transport & { calls: number } {
  const transport = {
    calls: 0,
    async send(_request: HttpRequest): Promise<HttpResponse> {
      const step = steps[transport.calls++];
      if (step === undefined) throw new Error("no scripted step left");
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return transport;
}

/** A clock whose sleeps return at once and are recorded; random() is fixed. */
function recordingClock(random = 0.5): RetryClock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms) => void sleeps.push(ms), random: () => random, now: () => NOW };
}

const get: HttpRequest = { method: "GET", path: "/stations/s1", headers: {} };

describe("RetryingTransport", () => {
  test("retries a 503 on GET and returns the first success", async () => {
    const inner = scripted([respond(503), respond(200)]);
    const clock = recordingClock();
    const response = await new RetryingTransport(inner, POLICY, clock).send(get);
    expect(response.status).toBe(200);
    expect(inner.calls).toBe(2);
    expect(clock.sleeps).toEqual([50]);
  });

  test("never retries a POST", async () => {
    const inner = scripted([respond(503)]);
    const response = await new RetryingTransport(inner, POLICY, recordingClock()).send({ ...get, method: "POST" });
    expect(response.status).toBe(503);
    expect(inner.calls).toBe(1);
  });

  test("does not retry a status that names a bad request", async () => {
    const inner = scripted([respond(400)]);
    const response = await new RetryingTransport(inner, POLICY, recordingClock()).send(get);
    expect(response.status).toBe(400);
    expect(inner.calls).toBe(1);
  });

  test("backoff bounds double per attempt and stop at maxDelayMs", async () => {
    const inner = scripted([respond(502), respond(502), respond(502), respond(502), respond(200)]);
    const clock = recordingClock(0.999);
    await new RetryingTransport(inner, { ...POLICY, maxAttempts: 5, maxDelayMs: 300 }, clock).send(get);
    expect(clock.sleeps).toEqual([99, 199, 299, 299]);
  });

  test("waits the Retry-After seconds, capped at maxDelayMs", async () => {
    const clock = recordingClock();
    const inner = scripted([respond(429, { "retry-after": "0" }), respond(429, { "retry-after": "120" }), respond(200)]);
    await new RetryingTransport(inner, POLICY, clock).send(get);
    expect(clock.sleeps).toEqual([0, 1_000]);
  });

  test("reads a Retry-After HTTP date relative to now", async () => {
    const clock = recordingClock();
    const inner = scripted([respond(503, { "retry-after": new Date(NOW + 5_000).toUTCString() }), respond(200)]);
    await new RetryingTransport(inner, { ...POLICY, maxDelayMs: 10_000 }, clock).send(get);
    expect(clock.sleeps).toEqual([5_000]);
  });

  test("a Retry-After date in the past retries at once", async () => {
    const clock = recordingClock();
    const inner = scripted([respond(503, { "retry-after": new Date(NOW - 60_000).toUTCString() }), respond(200)]);
    await new RetryingTransport(inner, POLICY, clock).send(get);
    expect(clock.sleeps).toEqual([0]);
  });

  test("falls back to backoff when Retry-After is not a delay or a date", async () => {
    const clock = recordingClock();
    const inner = scripted([respond(503, { "retry-after": "soon" }), respond(200)]);
    await new RetryingTransport(inner, POLICY, clock).send(get);
    expect(clock.sleeps).toEqual([50]);
  });

  test("returns the last response once attempts run out", async () => {
    const inner = scripted([respond(504), respond(504), respond(504)]);
    const response = await new RetryingTransport(inner, POLICY, recordingClock()).send(get);
    expect(response.status).toBe(504);
    expect(inner.calls).toBe(3);
  });

  test("retries a network failure and rethrows it after the last attempt", async () => {
    const failure = new TypeError("network down");
    const inner = scripted([failure, failure, failure]);
    const clock = recordingClock();
    await expect(new RetryingTransport(inner, POLICY, clock).send(get)).rejects.toBe(failure);
    expect(inner.calls).toBe(3);
    expect(clock.sleeps).toEqual([50, 100]);
  });

  test("retries a PUT, which replaces its batch by id", async () => {
    const inner = scripted([new TypeError("reset"), respond(204)]);
    const response = await new RetryingTransport(inner, POLICY, recordingClock()).send({ ...get, method: "PUT", body: "[]" });
    expect(response.status).toBe(204);
    expect(inner.calls).toBe(2);
  });
});
