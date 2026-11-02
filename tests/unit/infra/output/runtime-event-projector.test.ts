import { describe, expect, test } from "bun:test";
import { OutputProjector } from "../../../../src/infra/output/output-projector.js";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector.js";

describe("runtime terminal text projection", () => {
  test("a divergent terminal value replaces the keyed draft", () => {
    const output = new OutputProjector({ executionCwd: "/workspace" });
    const runtime = new RuntimeEventProjector(output);
    runtime.dispatch({ type: "model.content.delta", data: { delta: { type: "text_delta", text: "draft" }, block_key: "message:1" } }, 1);
    runtime.dispatch({ type: "model.text.reconciled", data: { content: "final", block_key: "message:1" } }, 2);
    expect(output.getBlocks().filter((block) => block.kind === "text")).toEqual([
      expect.objectContaining({ kind: "text", content: "final" }),
    ]);
  });
});

describe("live tool result availability", () => {
  test("settles from the finalized payload with its output tail before the durable echo", () => {
    const output = new OutputProjector({ executionCwd: "/workspace" });
    const runtime = new RuntimeEventProjector(output);
    runtime.dispatch({
      type: "model.assistant_message.recorded",
      data: { message: { content: [{ type: "tool_use", id: "toolu_bash", name: "bash", input: { command: "printf final" } }] } },
    }, 1);

    runtime.dispatch({
      type: "tool.result.available",
      data: {
        tool_use_id: "toolu_bash",
        content: [{ type: "text", text: "provider content" }],
        outcome: "ok",
        execution_output_tail: "final tail",
      },
    }, 2);

    const settled = output.getBlocks().find((block) => block.kind === "tool");
    expect(settled).toEqual(expect.objectContaining({ kind: "tool", status: "completed", content: "final tail" }));

    runtime.dispatch({
      type: "tool.result.recorded",
      data: {
        tool_use_id: "toolu_bash",
        content: [{ type: "text", text: "durable echo" }],
        outcome: "ok",
        details: { diff: "must not replace availability" },
      },
    }, 3);

    const afterEcho = output.getBlocks().find((block) => block.kind === "tool");
    expect(afterEcho).toEqual(expect.objectContaining({
      kind: "tool",
      status: "completed",
      content: "final tail",
    }));
    expect(afterEcho?.kind === "tool" ? afterEcho.diff : undefined).toBeUndefined();
  });
});
