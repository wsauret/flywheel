import { describe, expect, it } from "bun:test";
import { NO_CHANGED_TOOLS } from "../../../../src/infra/output/output-block-delta";
import { StreamingToolTextStore } from "../../../../src/infra/output/streaming-tool-text";

function store() {
  let changes = 0;
  const text = new StreamingToolTextStore(() => { changes += 1; });
  return { text, changes: () => changes };
}

describe("StreamingToolTextStore change ledger", () => {
  it("names each tool whose entry changed since the last drain, once", () => {
    const { text } = store();
    text.append("w", "ab", "ts");
    text.append("w", "cd");
    text.replace("b", "line 1\n");
    expect(text.drainChanged()).toEqual(new Set(["w", "b"]));
    expect(text.drainChanged()).toBe(NO_CHANGED_TOOLS);
    expect(text.snapshot()).toEqual({ w: { content: "abcd", filetype: "ts" }, b: { content: "line 1\n" } });
  });

  it("holds appends as sanitized text, so the shipped offsets match what the client holds", () => {
    const { text } = store();
    text.append("w", "a");
    text.append("w", "b\u001b[31mc\r\nd");
    expect(text.snapshot().w?.content).toBe("abc\nd");
  });

  it("names cleared, silently cleared, and reset tools, and a tool that came and went", () => {
    const { text, changes } = store();
    text.append("w", "ab");
    text.drainChanged();
    text.clear("w");
    text.append("x", "never shipped");
    text.clear("x");
    expect(text.drainChanged()).toEqual(new Set(["w", "x"]));
    text.setProposedDiff("e", { files: [], unavailable: "malformed" });
    text.drainChanged();
    const notified = changes();
    text.clearSilently("e");
    expect(changes()).toBe(notified);
    expect(text.drainChanged()).toEqual(new Set(["e"]));
    text.append("r", "x");
    text.drainChanged();
    text.reset();
    expect(text.drainChanged()).toEqual(new Set(["r"]));
    expect(text.snapshot()).toEqual({});
  });

  it("releases a transferred tool without naming it, so its new owner continues it", () => {
    const { text } = store();
    text.append("k", "tail");
    text.release("k");
    expect(text.drainChanged()).toBe(NO_CHANGED_TOOLS);
    expect(text.snapshot()).toEqual({});
  });

  it("hands out one snapshot identity per state", () => {
    const { text } = store();
    text.append("w", "a");
    const first = text.snapshot();
    expect(text.snapshot()).toBe(first);
    text.append("w", "b");
    const second = text.snapshot();
    expect(second).not.toBe(first);
    expect(second).toEqual({ w: { content: "ab" } });
    text.clear("w");
    expect(text.snapshot()).toEqual({});
  });
});
