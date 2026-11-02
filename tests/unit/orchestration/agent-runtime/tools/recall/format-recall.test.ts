import { describe, it, expect } from "bun:test";
import { formatRecallOutput } from "../../../../../../src/orchestration/agent-runtime/tools/recall/format-recall.js";
import type { RecallHit } from "../../../../../../src/protocol/conversation-recall.js";

describe("formatRecallOutput", () => {
  it("shows no-entries message without query", () => {
    expect(formatRecallOutput([])).toContain("No entries");
  });

  it("shows match count with query", () => {
    const entries: RecallHit[] = [
      { index: 2, entryId: "entry-2", role: "assistant", summary: "done" },
    ];
    const r = formatRecallOutput(entries, "done");
    expect(r).toContain('Found 1 matches for "done"');
  });

  it("formats bounded expanded text and continuation metadata", () => {
    const r = formatRecallOutput([{
      index: 2,
      entryId: "entry-2",
      role: "assistant",
      summary: "ignored",
      text: "selected text",
      offset: 0,
      totalLength: 40,
      nextOffset: 13,
    }]);
    expect(r).toContain("#2 id:entry-2 [assistant] offset:0-13/40 nextOffset:13");
    expect(r).toContain("selected text");
  });
});
