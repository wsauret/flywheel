import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import type { ToolEntry } from "../../../../src/infra/output-blocks.js";
import {
  probeToolRenderPhase,
  renderProbeFrame,
  setRenderProbeEnabled,
} from "../../../../src/infra/render-probe.js";
import { renderToolEntry } from "./_tool-entry-render.js";

afterEach(() => {
  setRenderProbeEnabled(false);
  mock.restore();
});

function probePhase(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("phase" in payload)) return undefined;
  return typeof payload.phase === "string" ? payload.phase : undefined;
}

describe("tool entry render probe", () => {
  it("marks a settled mounted tool for its first containing frame", async () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {});
    const entry: ToolEntry = {
      kind: "tool",
      id: "write-1",
      name: "write",
      presentation: { name: "Write", detail: "example.ts" },
      status: "completed",
      content: "const settled = true",
      filetype: "typescript",
      timestamp: Date.now(),
    };
    setRenderProbeEnabled(true);
    probeToolRenderPhase("write-1", "application");
    const result = await renderToolEntry(entry);
    try {
      await result.renderOnce();
      renderProbeFrame();
      const firstFrame = record.mock.calls
        .map(([event]) => event.payload)
        .find((payload) => probePhase(payload) === "first-frame");
      expect(firstFrame).toEqual({
        toolUseId: "write-1",
        phase: "first-frame",
        monotonicEpochMs: expect.any(Number),
      });
    } finally {
      result.renderer.destroy();
    }
  });
});
