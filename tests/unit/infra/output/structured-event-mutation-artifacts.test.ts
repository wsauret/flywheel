import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { extractDisplayMeta } from "../../../../src/infra/output/structured-event-tool-results.js";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder.js";
import { RuntimeEventFrameSchema, RuntimeUiPatchSchema } from "../../../../src/protocol/runtime-protocol-schemas.js";
import { agentBlock, outputPatch, resolveTrackedToolResult, textContent, toolBlock } from "./_tool-result-fixtures.js";

describe("canonical mutation artifacts", () => {
  const EVIDENCE = {
    version: 2,
    manifest: { version: 1, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
    applied: 5000, retainedFiles: 4999, omissions: 1, notApplied: 0, added: 0, modified: 5000, removed: 0,
    addedLines: 6000, removedLines: 4000, conflictMarkers: 0,
    samples: [{ kind: "applied", path: "/workspace/src/a.ts" }],
  } as const;

  it("projects bounded evidence without legacy patches, including failed settled prefixes", () => {
    for (const outcome of ["ok", "error", "interrupted"] as const) {
      const builder = new StructuredOutputBuilder();
      builder.pushStandaloneToolEntry({
        kind: "tool", id: "edit-evidence", name: "edit", presentation: { name: "Edit", detail: "src/a.ts" },
        timestamp: 1, status: "pending",
        proposedDiff: { files: [], unavailable: "malformed" },
      });
      resolveTrackedToolResult(builder, { kind: "standalone", toolName: "edit", streamsInput: false },
        "edit-evidence", outcome, textContent("settled"), { mutationEvidence: EVIDENCE, diff: "-secret\n+secret" });
      const tool = toolBlock(builder);
      expect(tool.mutationEvidence).toEqual({
        ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }],
      });
      expect(Object.hasOwn(tool, "mutation")).toBe(false);
      expect(tool.diff).toBeUndefined();
      expect(tool.proposedDiff).toBeUndefined();
      expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(
        Schema.encodeUnknownSync(RuntimeUiPatchSchema)(outputPatch(tool)))).toEqual(outputPatch(tool));
    }
  });

  it("keeps advisory previews separate and does not expose sensitive legacy content", () => {
    const identity = { source: "edit", toolUseId: "sensitive" };
    expect(extractDisplayMeta({ diff: "-advice\n+proposal" }, identity)).toEqual({ diff: "-advice\n+proposal" });
    const sensitive = { ...EVIDENCE, omissions: 5000, samples: [] };
    expect(extractDisplayMeta({ mutationEvidence: sensitive, files: [{ path: ".env", diff: "-secret\n+secret" }] }, identity))
      .toEqual({ mutationEvidence: sensitive });
    expect(() => extractDisplayMeta({ mutationEvidence: { ...EVIDENCE, samples: Array.from({ length: 4 }, () => EVIDENCE.samples[0]) } }, identity))
      .toThrow(/malformed mutationEvidence/);
  });

  it("keeps resolved skill scope beside mutation evidence on the completed row", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({ kind: "tool", id: "toolu_m", name: "skill_manage", presentation: { name: "Save Skill", detail: "example" }, timestamp: Date.now(), status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "skill_manage", streamsInput: false },
      "toolu_m",
      "ok",
      textContent("Skill saved. Reach: global."),
      { mutationEvidence: EVIDENCE, resultAction: "created" },
    );

    const tool = toolBlock(builder);
    expect(tool.status).toBe("completed");
    expect(tool.mutationEvidence).toEqual({ ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }] });
    expect(tool.resultAction).toBe("created");
    expect(tool.content).toContain("Reach: global.");
    expect(tool.diff).toBeUndefined();
  });

  it("keeps the artifact of a nested learning write expandable on the child row", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Working" }, now, "tu-agent-1");
    const childIndex = builder.pushToolRowToAgent("agent-1", { kind: "tool", id: "toolu_m", name: "skill_manage", presentation: { name: "Save Skill", detail: "example" }, timestamp: now, status: "pending" });

    resolveTrackedToolResult(
      builder,
      { kind: "row", agentId: "agent-1", childIndex, toolName: "skill_manage", streamsInput: false, inSubagent: true },
      "toolu_m",
      "ok",
      textContent("{\"success\":true}"),
      { mutationEvidence: EVIDENCE, resultAction: "created", diff: "-a\n+b", filetype: "typescript" },
    );

    const group = agentBlock(builder);
    const child = group.children[0];
    expect(child?.status).toBe("completed");
    expect(child?.mutationEvidence).toEqual({ ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }] });
    expect(child?.resultAction).toBe("created");
    // Preview-bearing fields still stay out of a compact child row.
    expect(child?.diff).toBeUndefined();
    expect(child?.filetype).toBeUndefined();
    expect(Object.hasOwn(child ?? {}, "diff")).toBe(false);
    expect(Object.hasOwn(child ?? {}, "filetype")).toBe(false);
  });

  it("recognizes only the canonical artifact contract, and refuses a present shape that is not it", () => {
    const identity = { source: "skill_manage", toolUseId: "toolu_m" } as const;
    expect(extractDisplayMeta({ mutationEvidence: EVIDENCE }, identity).mutationEvidence).toEqual(EVIDENCE);
    // Absent is ordinary: most results publish no artifact at all.
    expect(extractDisplayMeta({ diff: "-a\n+b" }, identity).mutationEvidence).toBeUndefined();
    expect(extractDisplayMeta({}, identity).mutationEvidence).toBeUndefined();
    // Present but not the contract: a producer defect, named rather than dropped.
    for (const malformed of [{ ...EVIDENCE, version: 1 }, { manifest: EVIDENCE.manifest }, "a diff", null]) {
      expect(() => extractDisplayMeta({ mutationEvidence: malformed }, identity)).toThrow(/malformed mutationEvidence in skill_manage result details for toolu_m/);
    }
    expect(extractDisplayMeta({ resultAction: "invented" }, identity).resultAction).toBeUndefined();
  });

  it("uses the canonical mutation instead of a sensitive legacy diff", () => {
    const mutationEvidence = { ...EVIDENCE, applied: 0, retainedFiles: 0, omissions: 1, unknownChanges: 1, samples: [] };
    const meta = extractDisplayMeta({
      files: [{ path: ".env", diff: "-API_KEY=old\n+API_KEY=new", filetype: "text" }],
      mutationEvidence,
    }, { source: "edit", toolUseId: "toolu_sensitive" });

    expect(meta).toEqual({ mutationEvidence });
  });

  it("replaces an input-derived preview when successful details carry a verified mutation", () => {
    const builder = new StructuredOutputBuilder();
    builder.pushStandaloneToolEntry({
      kind: "tool",
      id: "toolu_verified",
      name: "edit",
      presentation: { name: "Edit", detail: "src/a.ts" },
      timestamp: Date.now(),
      status: "pending",
      diff: "-unverified\n+preview",
      filetype: "diff",
    });

    resolveTrackedToolResult(
      builder,
      { kind: "standalone", toolName: "edit", streamsInput: false },
      "toolu_verified",
      "ok",
      textContent("done"),
      { mutationEvidence: EVIDENCE },
    );

    const tool = toolBlock(builder);
    expect(tool).toEqual(expect.objectContaining({
      status: "completed",
      mutationEvidence: { ...EVIDENCE, samples: [{ kind: "applied", path: "src/a.ts" }] },
    }));
    expect(tool.diff).toBeUndefined();
    expect(tool.filetype).toBeUndefined();
    expect(tool.presentation).toEqual({ name: "Edit", detail: "src/a.ts" });
    expect(Object.hasOwn(tool, "diff")).toBe(false);
    expect(Object.hasOwn(tool, "filetype")).toBe(false);

    const patch = outputPatch(tool);
    expect(Schema.encodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch);
  });

  it("deletes explicitly cleared child preview keys while preserving absent patch fields", () => {
    const builder = new StructuredOutputBuilder();
    const now = Date.now();
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Subagent", description: "Working" }, now, "tu-agent-1");
    const childIndex = builder.pushToolRowToAgent("agent-1", {
      kind: "tool",
      id: "toolu_m",
      name: "skill_manage",
      presentation: { name: "Save Skill", detail: "example" },
      timestamp: now,
      status: "pending",
      diff: "-unverified\n+preview",
      filetype: "diff",
    });

    const completion = {
      mutationEvidence: EVIDENCE,
      diff: undefined,
      filetype: undefined,
    };
    expect(Object.hasOwn(completion, "diff")).toBe(true);
    expect(Object.hasOwn(completion, "presentation")).toBe(false);
    builder.completeAgentChildTool("agent-1", childIndex, completion);

    const group = agentBlock(builder);
    const child = group.children[0];
    expect(child?.status).toBe("completed");
    expect(child?.presentation).toEqual({ name: "Save Skill", detail: "example" });
    expect(child?.diff).toBeUndefined();
    expect(child?.filetype).toBeUndefined();
    expect(Object.hasOwn(child ?? {}, "diff")).toBe(false);
    expect(Object.hasOwn(child ?? {}, "filetype")).toBe(false);

    const frame = { type: "patch", patch: outputPatch(group) } as const;
    expect(Schema.encodeUnknownSync(RuntimeEventFrameSchema)(frame)).toEqual(frame);
  });

  it("keeps the legacy per-file diff of an edit alongside an artifact-free result", () => {
    const meta = extractDisplayMeta({ files: [{ path: "src/a.ts", diff: "-a\n+b", filetype: "typescript" }] }, { source: "edit", toolUseId: "toolu_e" });
    expect(meta).toEqual({ diff: "-a\n+b", filetype: "typescript" });
  });
});
