import { describe, it, expect, beforeEach } from "bun:test";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

describe("outputLines sliding window cap", () => {
  let store: UIActions;

  beforeEach(() => {
    store = createStore("test-plan");
  });

  it("keeps lines under cap without trimming", () => {
    for (let i = 0; i < 100; i++) {
      store.appendOutput({ stream: "stdout", data: `line ${i}\n`, timestamp: `t${i}` });
    }
    expect(store.getState().outputLines).toHaveLength(100);
  });

  it("caps outputLines at 5000 by discarding oldest", () => {
    for (let i = 0; i < 5050; i++) {
      store.appendOutput({ stream: "stdout", data: `line ${i}\n`, timestamp: `t${i}` });
    }
    const lines = store.getState().outputLines;
    expect(lines.length).toBeLessThanOrEqual(5000);
    // The most recent line should be the last one appended
    expect(lines[lines.length - 1].data).toBe("line 5049\n");
    // The first line should NOT be "line 0" — it was trimmed
    expect(lines[0].data).not.toBe("line 0\n");
  });

  it("retains exactly 5000 lines when cap is hit", () => {
    for (let i = 0; i < 5001; i++) {
      store.appendOutput({ stream: "stdout", data: `line ${i}\n`, timestamp: `t${i}` });
    }
    expect(store.getState().outputLines).toHaveLength(5000);
  });

  it("keeps most recent lines when capping", () => {
    for (let i = 0; i < 5100; i++) {
      store.appendOutput({ stream: "stdout", data: `line ${i}\n`, timestamp: `t${i}` });
    }
    const lines = store.getState().outputLines;
    // First line should be line 100 (oldest 100 trimmed)
    expect(lines[0].data).toBe("line 100\n");
    expect(lines[lines.length - 1].data).toBe("line 5099\n");
  });
});
