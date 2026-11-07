import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { loadWorkflowDefinitions } from "../../../helpers/workflow-files.js";
import { decodeWorkflowFile } from "../../../../src/workflows/workflow-file.js";
import { workflowBriefs, type LoadedBrief } from "../../../../src/workflows/brief.js";
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js";
import { fileTemporaryDirectory } from "../../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-def-loader-test-");
const DIR = join(TMP, "workflows");

/** A workflow whose one phase is `work`, with the given record lines. */
const workflowYaml = (id: string, recordLines: readonly string[]): string => [
  `id: ${id}`,
  `name: ${id}`,
  "phases:",
  "  - phase: work",
  ...recordLines.map((line) => `    ${line}`),
].join("\n");

/** A saved file of the retired step grammar whose one step is `work`.
 *  Remove after 2027-04-30 with the step-grammar conversion. */
const stepWorkflowYaml = (id: string, stepLines: readonly string[]): string => [
  `id: ${id}`,
  `name: ${id}`,
  "steps:",
  "  work:",
  ...stepLines.map((line) => `    ${line}`),
  "flow:",
  "  - step: work",
].join("\n");

function write(relativePath: string, text: string): string {
  const path = join(DIR, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function load(): ReturnType<typeof loadWorkflowDefinitions> {
  return loadWorkflowDefinitions(DIR);
}

function brief(workflow: WorkflowDefinition | undefined, definitionId = "work"): LoadedBrief {
  const loaded = workflow && workflowBriefs(workflow).get(definitionId);
  if (!loaded) throw new Error(`agent ${definitionId} did not load`);
  return loaded;
}

function authored(workflow: WorkflowDefinition | undefined, definitionId = "work") {
  return brief(workflow, definitionId);
}

beforeEach(() => {
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("loadWorkflowDefinitions", () => {
  // Nested containers multiply values; a long string multiplies bytes.
  const AMPLIFIED = {
    containers: [
      "name: Inline",
      "brief: Do it.",
      "output:",
      "  fields:",
      "    f0: &a0 { type: string, description: Result }",
      ...Array.from({ length: 5 }, (_level, index) => {
        const level = index + 1;
        const aliases = Array.from({ length: 10 }, (_, child) => `k${child}: *a${level - 1}`).join(", ");
        return `    f${level}: &a${level} { type: object, fields: { ${aliases} } }`;
      }),
    ],
    strings: [
      "name: Inline",
      `brief: &long ${"x".repeat(100_000)}`,
      "output:",
      "  fields:",
      "    first: { type: string, description: *long }",
      "    second: { type: string, description: *long }",
    ],
    sequenceKeys: [
      "name: Inline",
      `brief: &long ${"x".repeat(50_000)}`,
      ...Array.from({ length: 10 }, (_, index) => `x-key-${index}: { ? [${Array.from({ length: 100 }, () => "*long").join(", ")}] : v }`),
    ],
  };

  it.each(["decoder", "file"].flatMap((boundary) => Object.entries(AMPLIFIED).map(([amplifier, body]) => [boundary, amplifier, body] as const)))("refuses YAML alias amplification before normalizing through the %s (%s)", (boundary, _amplifier, body) => {
    const yaml = workflowYaml("alias-test", body);
    if (boundary === "decoder") {
      const result = decodeWorkflowFile({ file: "aliases.yaml", content: yaml });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("alias amplification decoded");
      expect(result.diagnostics).toEqual([expect.objectContaining({
        file: "aliases.yaml", keyPath: "(root)", message: expect.stringContaining("YAML aliases"),
      })]);
    } else {
      const file = write("aliases.yaml", yaml);
      const { results, errors } = load();
      expect(results.size).toBe(0);
      expect(errors).toEqual([expect.objectContaining({ file, message: expect.stringContaining("YAML aliases") })]);
    }
  });

  it("keeps small YAML aliases readable through the decoder and file loader", () => {
    const yaml = workflowYaml("alias-test", [
      "name: Inline", "brief: Do it.", "output:", "  fields:",
      "    first: &text { type: string }", "    second: *text",
    ]);
    const decoded = decodeWorkflowFile({ file: "aliases.yaml", content: yaml });
    expect(decoded.ok).toBe(true);
    write("aliases.yaml", yaml);
    const { results, errors } = load();
    expect(errors).toEqual([]);
    expect(authored(results.get("alias-test")).output.fields.map(({ key }) => key)).toEqual(["first", "second"]);
  });

  // A merge key expands inside the YAML parser itself, before any count over
  // the parsed tree, so the parse must not expand one at all.
  it.each([
    { feature: "cyclic aliases", body: ["name: Inline", "brief: Do it.", "output: &cycle { fields: { self: *cycle } }"], message: "The file contains cyclic YAML aliases" },
    { feature: "a merge key", body: ["name: Inline", "brief: Do it.", "output:", "  fields:", "    first: &text { type: string }", "    second: { <<: *text }"], message: "The file uses a YAML merge key (<<)" },
  ].flatMap((input) => (["decoder", "file"] as const).map((boundary) => ({ ...input, boundary }))))("refuses $feature through the $boundary", ({ body, message, boundary }) => {
    const yaml = workflowYaml("refused", body);
    if (boundary === "decoder") {
      const result = decodeWorkflowFile({ file: "refused.yaml", content: yaml });
      if (result.ok) throw new Error("refused YAML decoded");
      expect(result.diagnostics).toEqual([expect.objectContaining({ keyPath: "(root)" })]);
      expect(result.diagnostics[0]?.message).toStartWith(message);
    } else {
      const file = write("refused.yaml", yaml);
      const { results, errors } = load();
      expect(results.size).toBe(0);
      expect(errors).toEqual([expect.objectContaining({ file, message: expect.stringContaining(message) })]);
    }
  });

  it("loads a workflow from .yml", () => {
    write("test.yml", workflowYaml("test-wf-yml", ["name: Inline", "brief: Do it."]));

    const { results, errors } = load();
    expect(errors).toEqual([]);
    expect(results.get("test-wf-yml")?.phases[0]).toEqual({ phase: "work", name: "Inline", brief: "Do it." });
  });

  it.each([
    ["test-wf", "work"], ["test-wf", "review_a"], ["test-wf", "status"],
    ["help", "review_a"], ["normal.workflow", "review_a"],
  ])("loads inline brief %s.%s with the workflow-qualified brief id", (workflowId, phaseId) => {
    write("test.yaml", workflowYaml(workflowId, ["name: Inline Work", "brief: Do the inline work.", "dependencies: [research]"])
      .replace("phase: work", `phase: ${phaseId}`));

    const { results, errors } = load();
    expect(errors).toEqual([]);
    const loaded = authored(results.get(workflowId), phaseId);
    expect(loaded).toMatchObject({ briefId: `${workflowId}.${phaseId}` });
    expect(loaded.procedure).toEqual({ name: "Inline Work", dependencies: ["research"], subagents: [], body: "Do the inline work." });
  });

  it("names an inline brief by its record id when the record states no name", () => {
    write("test.yaml", workflowYaml("test-wf", ["brief: Do it."]));

    const { results, errors } = load();
    expect(errors).toEqual([]);
    expect(authored(results.get("test-wf")).procedure.name).toBe("work");
  });

  it("refuses an inline workflow whose id cannot prefix a qualified brief id", () => {
    write("test.yaml", workflowYaml("global_test", ["name: Inline", "brief: Return the result."]));
    const { results, errors } = load();
    expect(results.has("global_test")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("global_test");
  });

  it("reuses an inline brief's body and dependencies with a record-specific name", () => {
    write("test.yaml", workflowYaml("test-wf", ["brief: Do it.", "dependencies: [research]"])
      + "\n  - phase: again\n    runs: work\n    name: Renamed\n");

    const { results, errors } = load();
    expect(errors).toEqual([]);
    const workflow = results.get("test-wf");
    expect(authored(workflow, "again").procedure).toMatchObject({ name: "Renamed", dependencies: ["research"], body: "Do it." });
    expect(workflow && resolveWorkflowAgents(workflow).get("again")).toMatchObject({ name: "Renamed", dependencies: ["research"], body: "Do it." });
  });

  it("resolves an inline brief's output path relative to the workflow file", () => {
    const contract = (summary: string): string => JSON.stringify({ summary, fields: { result: { type: "string", description: "The result." } } });
    write("shared/from-workflow.json", contract("Read through the workflow file."));
    write("test.yaml", [
      "id: test-wf",
      "name: test-wf",
      "phases:",
      "  - phase: other",
      "    brief: Other work.",
      "    output: shared/from-workflow.json",
    ].join("\n"));

    const { results, errors } = load();
    expect(errors).toEqual([]);
    const workflow = results.get("test-wf");
    expect(authored(workflow, "other").output.instructions(true)).toContain("Read through the workflow file.");
    expect(authored(workflow, "other").output.fields.map(({ key }) => key)).toContain("result");
  });

  it("names the contract file when its output contract is invalid", () => {
    const file = write("contracts/bad.json", JSON.stringify({ fields: { result: { type: "nope" } } }));
    write("test.yaml", workflowYaml("test-wf", ["brief: Work.", "output: contracts/bad.json"]));

    const { errors } = load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(file);
    expect(errors[0]?.message).toContain("invalid output contract");
  });

  it("refuses a brief name that this workflow file does not hold", () => {
    write("test.yaml", workflowYaml("test-wf", ["runs: fly.absent"]));

    const { errors } = load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('runs brief "fly.absent", which this file does not hold; write the brief inline');
  });

  it("refuses a Windows contract path on every platform and names the workflow file", () => {
    const file = write("test.yaml", workflowYaml("test-wf", ["brief: Do it.", "output: shared\\\\x.json"]));

    const { errors } = load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe(file);
    expect(errors[0]?.message).toContain("backslash");
  });

  it("refuses a contract path that leaves the workflow folder", () => {
    write("test.yaml", workflowYaml("test-wf", ["brief: Do it.", "output: ../outside/x.json"]));

    const { errors } = load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("leaves the root");
  });

  it("keeps an absent writes key absent in the record and resolves it to one transient artifact", () => {
    write("test.yaml", workflowYaml("test-wf", ["name: Inline", "brief: Do it."]));

    const workflow = load().results.get("test-wf");
    expect(workflow?.phases[0]).not.toHaveProperty("writes");
    const resolved = workflow && resolveWorkflowAgents(workflow).get("work");
    expect(resolved?.writes).toEqual([{ id: "work", lifetime: "transient" }]);
    expect(resolved?.briefId).toBe("test-wf.work");
  });

  it("refuses runs skill with advice to compose dependencies into an inline brief", () => {
    write("a.yaml", workflowYaml("skill-brief", ["runs: skill:fixture.root", "output: { summary: Done. }"]));

    expect(load().errors.map(({ message }) => message).join("\n")).toContain('a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [fixture.root]');
  });

  it("loads a file whose mistake has one reading as that reading, and names each repair in one warning", () => {
    write("split.yaml", workflowYaml("split-wf", ["name: Inline", "brief: Do it.", "output:", "  fields:", "    note: { type: string, description: The change,\n        in one sentence. }"]));

    const { results, errors, decoded } = load();
    expect(errors).toEqual([]);
    expect(results.get("split-wf")?.phases[0]).toMatchObject({ output: { fields: { note: { type: "string", description: "The change, in one sentence." } } } });
    // The second line of the flow mapping sits at its key's column, which
    // js-yaml 5 refuses and js-yaml 4 read.
    expect(decoded.get("split-wf")?.repairs).toEqual([
      { keyPath: "(root)", message: expect.stringContaining("line 10 continues a flow collection or quoted text with less indentation than its key") },
      expect.objectContaining({ keyPath: "phases.0.output.fields.note.description", message: expect.stringContaining("an unquoted comma split this text") }),
    ]);
  });

  it("reports a YAML error on a line whose indentation it raised at the column of the file", () => {
    const decoded = decodeWorkflowFile({ file: "raised.yaml", content: workflowYaml("raised", ["name: Inline", "brief: Do it.", "output:", "  fields:", "    note: { type: string,\n        description: [ }"]) });
    if (decoded.ok) throw new Error("invalid YAML decoded");
    expect(decoded.diagnostics).toEqual([expect.objectContaining({ keyPath: "(root)", message: expect.stringMatching(/^The file is not valid YAML at line 10, column 24: /) })]);
  });

  // Each raise parses the whole file again, so an unbounded count of raised
  // lines costs time that grows with the square of the file.
  it("refuses a file with more under-indented flow lines than the parse raises, at the line it refused", () => {
    const items = Array.from({ length: 100 }, (_, index) => `step${index},`).join("\n");
    const decoded = decodeWorkflowFile({ file: "many.yaml", content: workflowYaml("many", ["name: Inline", "brief: Do it.", `dependencies: [first,\n${items}\nlast]`]) });
    if (decoded.ok) throw new Error("a file with 100 raised lines decoded");
    expect(decoded.diagnostics).toEqual([expect.objectContaining({ keyPath: "(root)", message: expect.stringMatching(/^The file is not valid YAML at line \d+, column 1: deficient indentation$/) })]);
  });

  it("reads a sequence used as a mapping key as the key that its items join to", () => {
    write("key.yaml", workflowYaml("key-wf", ["name: Inline", "brief: Do it.", "output:", "  fields:", "    ? [note]", "    : { type: string, description: The change. }"]));

    const { results, errors } = load();
    expect(errors).toEqual([]);
    expect(results.get("key-wf")?.phases[0]).toMatchObject({ output: { fields: { note: { type: "string", description: "The change." } } } });
  });

  it("refuses a null block-mapping key after a description instead of reading it as text", () => {
    const text = workflowYaml("block-key", ["name: Inline", "brief: Do it.", "output:", "  fields:", "    note:", "      type: string", "      description: Evidence", "      requird: null"]);
    write("block-key.yaml", text);
    const loaded = load();
    expect(loaded.results.size).toBe(0);
    expect(loaded.errors[0]?.message).toContain("requird");
    expect(loaded.warnings).toEqual([]);
  });

  it.each(["string", "path", "number"])("drops files_modified only for an envelope-shaped list (item type %s)", (type) => {
    write("files.yaml", workflowYaml("files", ["name: Inline", "brief: Do it.", "output:", "  fields:", `    files_modified: { type: list, description: Changed files., of: { type: ${type} } }`]));
    const loaded = load();
    if (type === "number") {
      expect(loaded.results.size).toBe(0);
      expect(loaded.errors[0]?.message).toContain("files_modified");
      expect(loaded.warnings).toEqual([]);
    } else {
      expect(loaded.errors).toEqual([]);
      expect(loaded.results.get("files")?.phases[0]).toMatchObject({ output: { fields: {} } });
      expect(loaded.decoded.get("files")?.repairs.map(({ message }) => message).join("\n")).toContain("dropped this field");
    }
  });

  it("refuses a numeric files_modified field instead of dropping it", () => {
    write("files.yaml", workflowYaml("files", ["name: Inline", "brief: Do it.", "output:", "  fields:", "    files_modified: { type: number, description: Number of changed files. }"]));
    const loaded = load();
    expect(loaded.results.size).toBe(0);
    expect(loaded.errors[0]?.message).toContain("files_modified");
    expect(loaded.warnings).toEqual([]);
  });

  it("rejects a workflow with no phases", () => {
    write("bare.yaml", "id: bare\nname: Bare\n");

    const { errors } = load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("phases");
  });

  it("refuses a repeat inside a repeat with one message that names the shape and the alternative", () => {
    const result = decodeWorkflowFile({
      file: "nested.yaml",
      content: "id: nested\nname: Nested\nphases:\n  - repeat: { while: a.f, max: 2 }\n    phases:\n      - repeat: { each: plan.items }\n        phases:\n          - phase: a\n            brief: A.\n",
    });
    if (result.ok) throw new Error("a nested repeat decoded");
    expect(result.diagnostics).toEqual([{
      file: "nested.yaml",
      keyPath: "phases.0.phases.0",
      message: "is a repeat inside a repeat, which a workflow cannot hold; put its phases in the outer repeat's phases, or move it to its own place after the outer repeat",
    }]);
  });

  it("rejects a dotted phase id, which would make an output reference ambiguous", () => {
    write("dotted.yaml", workflowYaml("dotted", ["name: Inline", "brief: Do it."]).replace("phase: work", "phase: fly.work"));

    const { errors } = load();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("a phase or agent name must start with a lowercase letter");
  });

  it("aggregates errors from multiple invalid workflow files", () => {
    write("bad1.yaml", "id: x\nname: X\n");
    write("bad2.yaml", "not: valid: yaml: [[[");

    expect(load().errors.length).toBe(2);
  });

  it("ignores non-YAML files", () => {
    write("notes.md", "not a workflow");
    const { results, errors } = load();
    expect(errors).toEqual([]);
    expect(results.size).toBe(0);
  });
});

// A saved file of the step grammar loads converted to phases, with the
// repairs that its build made. Remove after 2027-04-30 with the conversion.
describe("loading a saved file of the retired step grammar", () => {
  it("drops a step's retired selfReview key so an older workflow file still loads", () => {
    write("older.yaml", stepWorkflowYaml("older-wf", ["name: Inline", "instructions: Do it.", "selfReview: false"]));

    const { results, errors } = load();
    expect(errors).toEqual([]);
    expect(results.get("older-wf")?.phases).toEqual([{ phase: "work", name: "Inline", brief: "Do it." }]);
  });

  // Every agent gets the same tools and system prompt (ARCH-CONTEXT-018), so a file
  // that still scopes a step's tools or marks it as a check loads without
  // those keys, and one warning names each key path that it dropped.
  it("drops a step's retired toolScoping and kind keys, and names each of them in one warning", () => {
    write("scoped.yaml", stepWorkflowYaml("scoped-wf", ["name: Inline", "instructions: Do it.", "kind: check", "toolScoping:", "  read: true", "  ask_user: true"]));

    const { results, errors, decoded } = load();
    expect(errors).toEqual([]);
    expect(results.get("scoped-wf")?.phases).toEqual([{ phase: "work", name: "Inline", brief: "Do it." }]);
    expect(decoded.get("scoped-wf")?.retiredKeys).toEqual(["steps.work.kind", "steps.work.toolScoping"]);
    expect(decoded.get("scoped-wf")?.stepGrammar).toBeDefined();
  });

  it("names the repairs of a step-grammar file by their step key paths", () => {
    write("split.yaml", stepWorkflowYaml("split-wf", ["name: Inline", "instructions: Do it.", "output:", "  fields:", "    note: { type: string, description: The change,\n        in one sentence. }"]));

    const { results, errors, decoded } = load();
    expect(errors).toEqual([]);
    expect(results.get("split-wf")?.phases[0]).toMatchObject({ output: { fields: { note: { type: "string", description: "The change, in one sentence." } } } });
    expect(decoded.get("split-wf")?.repairs).toContainEqual(expect.objectContaining({ keyPath: "steps.work.output.fields.note.description", message: expect.stringContaining("an unquoted comma split this text") }));
  });

  it.each([undefined, "[]", "[first]", "12", "[12]"])("moves flow reads only into absent or string-array step reads (%s)", (reads) => {
    const text = stepWorkflowYaml("flow-reads", ["name: Inline", "instructions: Do it.", ...(reads === undefined ? [] : [`reads: ${reads}`])])
      .replace("steps:\n", "steps:\n  first:\n    name: First\n    instructions: Start.\n")
      .replace("  - step: work", "  - step: first\n  - step: work\n    reads: [first]");
    const decoded = decodeWorkflowFile({ file: "flow-reads.yaml", content: text });
    if (reads === "12" || reads === "[12]") {
      expect(decoded.ok).toBe(false);
      if (decoded.ok) throw new Error("invalid step reads decoded");
      // The step grammar fails as one decode of the retired schema, whose
      // message names the key at fault.
      expect(decoded.diagnostics.map(({ message }) => message).join("\n")).toContain('at ["steps"]["work"]["reads"]');
    } else {
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error(JSON.stringify(decoded.diagnostics));
      expect(decoded.definition.phases[1]).toMatchObject({ phase: "work", reads: ["first"] });
      expect(decoded.repairs.map(({ keyPath }) => keyPath)).toEqual(["flow.1.reads"]);
    }
  });
});

