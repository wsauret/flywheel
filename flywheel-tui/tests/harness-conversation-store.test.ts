import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMessages, rewriteMessages } from "../src/orchestration/engines/providers/harness/conversation-store.js";
import type { Message } from "../src/orchestration/engines/providers/harness/llm/types.js";

describe("conversation-store", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = join(tmpdir(), `harness-convo-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    file = join(dir, "conv.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("rewriteMessages replaces file content", () => {
    const a: Message[] = [{ role: "user", content: "first" }];
    const b: Message[] = [{ role: "user", content: "second" }, { role: "assistant", content: "reply" }];
    rewriteMessages(file, a);
    expect(loadMessages(file)).toEqual(a);
    rewriteMessages(file, b);
    expect(loadMessages(file)).toEqual(b);
  });

  test("loadMessages truncates orphan assistant(tool_use) at the end", () => {
    const messages: Message[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "tool_use", id: "A", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "A", content: "ok" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "B", name: "bash", input: {} }] },
    ];
    writeFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const loaded = loadMessages(file);

    expect(loaded).toHaveLength(3);
    expect(loaded[2]).toEqual(messages[2]!);
    // File is rewritten to the sanitized state.
    const onDisk = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    expect(onDisk).toHaveLength(3);
  });

  test("loadMessages truncates when tool_use has partially-matching tool_result", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "A", name: "read", input: {} },
          { type: "tool_use", id: "B", name: "read", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "A", content: "ok" }] },
    ];
    writeFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const loaded = loadMessages(file);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(messages[0]!);
  });

  test("loadMessages keeps a clean conversation intact", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "A", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "A", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    writeFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const loaded = loadMessages(file);

    expect(loaded).toEqual(messages);
    // File untouched.
    const onDisk = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    expect(onDisk).toHaveLength(4);
  });

  test("loadMessages returns [] for a missing file", () => {
    expect(loadMessages(join(dir, "nope.jsonl"))).toEqual([]);
  });

  test("loadMessages truncates when tool_use is last and nothing follows", () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "A", name: "read", input: {} }] },
    ];
    writeFileSync(file, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const loaded = loadMessages(file);

    expect(loaded).toHaveLength(1);
    expect(existsSync(file)).toBe(true);
  });
});
