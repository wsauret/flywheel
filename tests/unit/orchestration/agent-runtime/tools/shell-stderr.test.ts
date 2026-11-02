import { describe, expect, it } from "bun:test";

import { drainStderr } from "../../../../../src/orchestration/agent-runtime/tools/shell-stderr.js";

/** What a command's stderr reader passes on as the command's own output. */
function reader() {
  const passed: string[] = [];
  const first = Promise.withResolvers<void>();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  const drained = drainStderr({ pid: 4242, stderr: stream }, (text) => { passed.push(text); first.resolve(); });
  return { passed, first: first.promise, drained, push: (text: string) => output.enqueue(new TextEncoder().encode(text)), finish: () => output.close() };
}

describe("a command's parent-side stderr", () => {
  it("passes payload stderr before its newline", async () => {
    const stderr = reader();

    stderr.push("partial prompt without newline");

    await stderr.first;
    expect(stderr.passed.join("")).toBe("partial prompt without newline");
    stderr.finish();
    await stderr.drained;
  });

  it.each([
    ["an xtrace line", `+ ${"a".repeat(3_000)}${"b".repeat(3_000)}`],
    ["a line that opens like a record and outgrows one", `{"trace": "${"a".repeat(3_000)}${"b".repeat(3_000)}"}`],
  ])("passes %s longer than any record on whole across chunks", async (_case, line) => {
    const stderr = reader();

    for (const chunk of [line.slice(0, 3_000), line.slice(3_000, 5_000), `${line.slice(5_000)}\n`]) stderr.push(chunk);
    stderr.finish();
    await stderr.drained;

    expect(stderr.passed.join("")).toBe(`${line}\n`);
  });
});
