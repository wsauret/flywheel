import { describe, expect, it } from "bun:test";

import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { makeContext } from "./_fixtures.js";
import { createRefusedHandoff, handoffToolSchemaFromOutput } from "../../../../../src/orchestration/workflow-host/handoff-tool-schema.js";
import { compileOutput } from "../../../../../src/workflows/output-contract/compile.js";
import type { OutputObject } from "../../../../../src/workflows/output-contract/grammar.js";

// How the handoff tool reads a submission beyond its strict contract: one
// refusal for every problem, empty optional fields, and undeclared keys.

function toolFor(output: OutputObject) {
  return handoffToolSchemaFromOutput(compileOutput(output));
}

describe("handoff tool refusals", () => {
  it("names collapsed markup, missing fields, and every contract problem in one refusal, and hands the repaired submission to its owner", async () => {
    const tool = createHandoffTool({ schema: toolFor({
      summary: "What was done.",
      fields: {
        cause: { type: "string", description: "The cause." },
        notes: { type: "string", description: "Notes." },
        sources: { type: "list", max: 1, description: "Sources.", of: { type: "string" } },
      },
    }) });
    const rejections: unknown[] = [];
    const result = await tool.execute(
      { summary: "done</summary>\n<extra>more", cause: "Off by one.</cause>\n<notes>not a field here", sources: ["a", "b"] },
      makeContext({ handoff: { onContent: () => { throw new Error("nothing is accepted"); }, onRejected: (rejection) => { rejections.push(rejection); } } }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Your `summary` value contains an embedded tag (`</summary>`)");
    expect(result.content).toContain("Your `cause` value contains an embedded tag (`</cause>`)");
    expect(result.content).toContain("missing required top-level fields: notes");
    expect(result.content).toContain("sources: Expected a value with a length of at most 1");
    expect(rejections).toEqual([{
      payload: { summary: "done</summary>\n<extra>more", cause: "Off by one.</cause>\n<notes>not a field here", sources: ["a", "b"] },
      issues: [
        { path: "summary", message: "holds collapsed tool-call markup (`</summary>`)" },
        { path: "cause", message: "holds collapsed tool-call markup (`</cause>`)" },
        { path: "notes", message: "is a required top-level field and is missing" },
        { path: "sources", message: "Expected a value with a length of at most 1" },
      ],
    }]);
  });

  it("hands its owner a refused submission with every clear repair, so a delivery reads one item sent alone as a list of it", async () => {
    const tool = createHandoffTool({ schema: toolFor({
      summary: "What was done.",
      fields: {
        title: { type: "string", description: "Title." },
        targets: { type: "list", description: "Targets.", of: { type: "object", fields: { id: { type: "string" }, count: { type: "number" }, note: { type: "string", optional: true } } } },
      },
    }) });
    const rejections: unknown[] = [];
    await tool.execute(
      { summary: "done", title: "", targets: { id: "a", count: "2", note: "" } },
      makeContext({ handoff: { onContent: () => {}, onRejected: (rejection) => { rejections.push(rejection); } } }),
    );

    expect(rejections).toEqual([expect.objectContaining({ payload: { summary: "done", title: "", targets: [{ id: "a", count: 2 }] } })]);
  });

  it("delivers the latest refused submission it could read, and an empty payload with the reason when it read none", () => {
    const refused = createRefusedHandoff();
    expect(refused.delivered()).toBeUndefined();
    const unreadable = { issues: [{ path: "path", message: "path: the output file is not valid JSON at line 1" }] };
    refused.record(unreadable);
    expect(refused.delivered()).toEqual({ payload: {}, issues: unreadable.issues });
    const read = { payload: { summary: "done" }, issues: [{ path: "title", message: "Missing key" }] };
    refused.record(read);
    refused.record(unreadable);
    expect(refused.delivered()).toEqual(read);
  });

  it("reads an empty optional field as absent at any depth and keeps undeclared keys with a note", async () => {
    const tool = createHandoffTool({ schema: toolFor({
      summary: "What was done.",
      fields: {
        title: { type: "string", description: "Title." },
        sketch: { type: "string", optional: true, description: "Sketch." },
        screens: { type: "list", description: "Screens.", of: { type: "object", fields: { name: { type: "string" }, sketch: { type: "string", optional: true } } } },
      },
    }) });
    const captured: unknown[] = [];
    const ctx = makeContext({ handoff: { onContent: (content) => { captured.push(content); } } });

    const accepted = await tool.execute({ summary: "done", title: "T", sketch: "  ", note: "extra", screens: [{ name: "home", sketch: "", layout_note: "grid" }] }, ctx);
    expect(accepted.outcome).toBe("ok");
    expect(accepted.content).toContain("Note: `sketch` held no text, so it was read as absent.");
    expect(accepted.content).toContain("Note: `screens.0.sketch` held no text, so it was read as absent.");
    expect(accepted.content).toContain("Note: `note` is not declared by the output contract; it was kept as written");
    expect(accepted.content).toContain("Note: `screens.0.layout_note` is not declared");
    expect(captured).toEqual([{ summary: "done", title: "T", note: "extra", screens: [{ name: "home", layout_note: "grid" }] }]);

    const required = await tool.execute({ summary: "done", title: " ", screens: [] }, ctx);
    expect(required.outcome).toBe("error");
    expect(required.content).toContain("title: expected a non-empty string");
  });
});
