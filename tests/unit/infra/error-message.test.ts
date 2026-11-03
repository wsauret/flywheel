import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { diagnosticDetail, errorDetail, errorMessage } from "../../../src/infra/error-message.js";

describe("errorMessage", () => {
  it("redacts recognized provider credentials from error messages", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-");
    const message = errorMessage(
      new Error(
        `401 Incorrect API key provided: ${secret}. Check your configuration.`,
      ),
    );

    expect(message).toBe("401 Incorrect API key provided: [redacted secret]. Check your configuration.");
  });

  it("preserves actionable environment variable names", () => {
    expect(errorMessage(new Error("OPENAI_API_KEY environment variable is required"))).toBe(
      "OPENAI_API_KEY environment variable is required",
    );
  });

  it("falls back to the error name when the message is empty (never a blank toast)", () => {
    class Timeout extends Error {
      override readonly name = "RuntimeCallTimeout";
      constructor() { super(""); }
    }
    expect(errorMessage(new Timeout())).toBe("RuntimeCallTimeout");
    expect(errorMessage(new Error("   "))).toBe("Error");
  });

  it("appends the cause chain when the message alone does not carry it", () => {
    const cause = new Error("Failed to start server. Is port 41000 in use?");
    expect(errorMessage(new Error("An error occurred during Open", { cause }))).toBe(
      "An error occurred during Open: Failed to start server. Is port 41000 in use?",
    );
    expect(errorMessage(new Error("connect failed: refused", { cause: new Error("refused") }))).toBe("connect failed: refused");
    expect(errorMessage(new Error("outer", { cause: new Error("middle", { cause: "inner text" }) }))).toBe("outer: middle: inner text");
  });

  // A shutdown barrier that settles several owners reports their failures as
  // one AggregateError. Its own message names none of them, so a record of
  // only that message cannot say what blocked the stop.
  it("names each member of an aggregate failure that its message does not already carry", () => {
    const members = [new Error("unknown fact tool.result.recorded@4; not registered"), new Error("auth admission closed")];
    expect(errorMessage(new AggregateError(members, "runtime supervisor disposal failed"))).toBe(
      "runtime supervisor disposal failed: unknown fact tool.result.recorded@4; not registered; auth admission closed",
    );
    expect(errorMessage(new AggregateError([new Error("disk full")], "write failed: disk full"))).toBe("write failed: disk full");
    expect(errorDetail(new AggregateError(members, "runtime supervisor disposal failed")).errors?.map((member) => member.message)).toEqual([
      "unknown fact tool.result.recorded@4; not registered",
      "auth admission closed",
    ]);
  });

  it("describes a schema decode failure by path and expected shape, never by the value", () => {
    const Block = Schema.Union([Schema.Struct({ kind: Schema.Literal("tool") }), Schema.Struct({ kind: Schema.Literal("text") })]);
    const content = "model-written ".repeat(50_000);
    let failure: unknown;
    try {
      Schema.decodeUnknownSync(Schema.Struct({ blocks: Schema.Array(Block) }))({ blocks: [{ kind: "workflowRoster", said: content }] });
    } catch (error) {
      failure = error;
    }

    const message = errorMessage(failure);
    expect(message).toBe('Expected { readonly "kind": "tool", ... } | { readonly "kind": "text", ... }\n  at ["blocks"][0]');
    expect(JSON.stringify(errorDetail(failure))).not.toContain("model-written");

    // A transformation's own message can quote the input, as a JSON parse error does.
    let parseFailure: unknown;
    try {
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))("model-written");
    } catch (error) {
      parseFailure = error;
    }
    expect(errorMessage(parseFailure)).toBe("Expected a valid JSON string");
    expect(JSON.stringify(errorDetail(parseFailure))).not.toContain("model-written");
  });
});

describe("diagnosticDetail", () => {
  it("keeps a structured detail as data and an error as its message", () => {
    // A connection reports a lane's end as a record such as
    // `{ kind: "closed", code: 1006 }`; read as text it was "[object Object]".
    expect(diagnosticDetail({ kind: "closed", code: 1006 })).toEqual({ kind: "closed", code: 1006 });
    expect(diagnosticDetail(new Error("socket hung up"))).toBe("socket hung up");
    expect(diagnosticDetail("plain")).toBe("plain");
    expect(diagnosticDetail(undefined)).toBeUndefined();
  });
});
