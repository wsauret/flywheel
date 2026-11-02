import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import * as yaml from "js-yaml";
import { compileOutput } from "../../../../src/workflows/output-contract/compile.js";
import { decodeOutputObject, type OutputObject } from "../../../../src/workflows/output-contract/grammar.js";
import { debugInvestigateFrontmatter, implementFrontmatter } from "./plan-contracts.js";

function decoded(input: unknown): OutputObject {
  const result = decodeOutputObject(input);
  if (Result.isFailure(result)) throw new Error(result.failure.join("\n"));
  return result.success;
}

function failures(input: unknown): readonly string[] {
  const result = decodeOutputObject(input);
  if (Result.isSuccess(result)) throw new Error("expected the grammar to reject the contract");
  return result.failure;
}

/** The `output` value of step md frontmatter, as YAML reads it. */
function frontmatterOutput(text: string): { readonly output: unknown } {
  const frontmatter = yaml.load(text);
  if (typeof frontmatter !== "object" || frontmatter === null || !("output" in frontmatter)) throw new Error("no output in frontmatter");
  return frontmatter;
}

const text = (description: string) => ({ type: "string", description });

describe("output contract grammar", () => {
  test("accepts every field type with its own keys", () => {
    const output = decoded({
      summary: "What happened.",
      commands: { min: 2 },
      fields: {
        title: text("A title."),
        count: { type: "number", description: "A count.", example: 3 },
        ready: { type: "boolean", description: "Readiness.", optional: true },
        level: { type: "enum", values: ["low", 2], description: "A level.", nullable: true },
        report: { type: "path", exists: false, description: "A report path." },
        items: { type: "list", of: { type: "object", fields: { id: text("An id.") } }, min: 0, max: 3, unique: "id", description: "Items." },
        choice: { type: "variant", tag: "kind", cases: { a: { id: text("An id.") }, b: { id: text("An id."), note: text("A note.") } }, description: "A choice." },
      },
    });
    expect(Object.keys(output.fields ?? {})).toEqual(["title", "count", "ready", "level", "report", "items", "choice"]);
  });

  test("accepts the absent form and the file form", () => {
    expect(decoded({})).toEqual({});
    expect(decoded({ submit: "file", summary: "The plan.", fields: { phases: { type: "list", of: { type: "string" }, description: "Phases." } } }).submit).toBe("file");
  });

  test("rejects unknown grammar keys at every level and names the key path", () => {
    expect(failures({ sumary: "x" })).toEqual(["sumary: is not a key of the output contract grammar"]);
    expect(failures({ fields: { notes: { ...text("Notes."), pattern: "^a" } } })).toEqual(["fields.notes.pattern: is not a key of the output contract grammar"]);
    expect(failures({ commands: { min: 1, max: 2 } })).toEqual(["commands.max: is not a key of the output contract grammar"]);
  });

  test("rejects keys that do not match the key pattern", () => {
    expect(failures({ fields: { Bad: text("Bad.") } }).join("\n")).toContain("expected a key that matches [a-z][a-z0-9_]*");
    expect(failures({ fields: { "1st": text("Bad.") } }).join("\n")).toContain("[a-z][a-z0-9_]*");
  });

  test("makes a description optional on keyed fields at every depth and forbids it on a list item", () => {
    const undescribed = { fields: { notes: { type: "string" }, rows: { type: "list", of: { type: "object", fields: { id: { type: "string" } } } }, choice: { type: "variant", tag: "kind", cases: { a: { id: { type: "string" } } } } } };
    expect(Result.isSuccess(decodeOutputObject(undescribed))).toBe(true);
    expect(failures({ fields: { notes: { type: "list", of: text("An item."), description: "Notes." } } }))
      .toEqual(["fields.notes.of.description: is not allowed on a list item; describe the list instead"]);
    expect(failures({ fields: { notes: { type: "list", of: { type: "string", optional: true }, description: "Notes." } } }))
      .toEqual(["fields.notes.of.optional: is not allowed on a list item"]);
  });

  test("rejects a key that the field type does not admit, and a missing required type key", () => {
    expect(failures({ fields: { name: { ...text("A name."), values: ["a"] } } })).toEqual(["fields.name.values: is not allowed on a string field"]);
    expect(failures({ fields: { name: { type: "list", description: "Names." } } })).toEqual(["fields.name.of: is required on a list field"]);
    expect(failures({ fields: { name: { type: "variant", tag: "kind", description: "A choice." } } })).toEqual(["fields.name.cases: is required on a variant field"]);
  });

  test("requires enum values to be present and unique", () => {
    expect(failures({ fields: { level: { type: "enum", values: [], description: "A level." } } })).toEqual(["fields.level.values: expected one or more enum values"]);
    expect(failures({ fields: { level: { type: "enum", values: ["a", "a"], description: "A level." } } })).toEqual(["fields.level.values: enum values must be unique"]);
  });

  test("allows unique only on lists of objects or variants that carry that required string key", () => {
    expect(failures({ fields: { ids: { type: "list", of: { type: "string" }, unique: "id", description: "Ids." } } }))
      .toEqual(["fields.ids.unique: is allowed only on a list whose items are objects or variants"]);
    expect(failures({ fields: { rows: { type: "list", of: { type: "object", fields: { id: { ...text("An id."), optional: true } } }, unique: "id", description: "Rows." } } }))
      .toEqual(['fields.rows.unique: each item must declare "id" as a required string']);
    expect(failures({ fields: { rows: { type: "list", of: { type: "variant", tag: "kind", cases: { a: { id: text("An id.") }, b: { note: text("A note.") } } }, unique: "id", description: "Rows." } } }))
      .toEqual(['fields.rows.unique: each variant case must declare "id" as a required string']);
  });

  test("rejects a list whose min is above its max", () => {
    expect(failures({ fields: { rows: { type: "list", of: { type: "string" }, min: 3, max: 2, description: "Rows." } } }))
      .toEqual(["fields.rows.max: must not be less than min (3)"]);
  });

  test("closes variant cases and keeps the tag out of the case keys", () => {
    expect(failures({ fields: { choice: { type: "variant", tag: "kind", cases: { a: { kind: text("Kind.") } }, description: "A choice." } } }))
      .toEqual(["fields.choice.cases.a.kind: repeats the variant tag; the tag value names the case"]);
  });

  test("rejects envelope keys inside fields", () => {
    expect(failures({ fields: { summary: text("Again.") } })).toEqual([`fields.summary: is an envelope key; describe it with the top-level "summary" key`]);
    expect(failures({ fields: { commands_run: text("Runs.") } })).toEqual([`fields.commands_run: is an envelope key; require citations with the top-level "commands" key`]);
    expect(failures({ fields: { files_modified: text("Files.") } })).toEqual(["fields.files_modified: is an envelope key; every inline output already carries it"]);
    expect(failures({ fields: { report: { type: "object", fields: { commands_run: text("Runs.") }, description: "A report." } } }))
      .toEqual(["fields.report.commands_run: commands_run exists only at the top level of the envelope"]);
    expect(failures({ fields: { grid: { type: "list", description: "Rows.", of: { type: "list", of: { type: "object", fields: { commands_run: text("Runs.") } } } } } }))
      .toEqual(["fields.grid.commands_run: commands_run exists only at the top level of the envelope"]);
  });

  test("rejects command citations on a file submission", () => {
    expect(failures({ submit: "file", commands: { min: 1 } })).toEqual(["commands: is not allowed with submit: file; a file payload carries no command citations"]);
  });
});

describe("the plan's step contracts", () => {
  test("the debug investigate contract of section 1.3 compiles as written", () => {
    const compiled = compileOutput(decoded(frontmatterOutput(debugInvestigateFrontmatter).output));
    expect(compiled.mode).toBe("inline");
    expect(compiled.fields.map(({ key, type, nullable }) => ({ key, type, nullable }))).toEqual([
      { key: "hypothesis", type: "string", nullable: true },
      { key: "evidence", type: "list", nullable: false },
    ]);
  });

  test("the implement contract of section 1.4 needs one description quoted before it compiles", () => {
    // The plan writes `description: A test name, file path, command, or symbol.`
    // inside a YAML flow mapping, where each comma ends an entry. YAML reads
    // the extra phrases as keys, and the closed grammar rejects them.
    expect(failures(frontmatterOutput(implementFrontmatter).output)).toEqual([
      "fields.contract_result.fields.directives.of.cases.satisfied.evidence.file path: is not a key of the output contract grammar",
      "fields.contract_result.fields.directives.of.cases.satisfied.evidence.command: is not a key of the output contract grammar",
      "fields.contract_result.fields.directives.of.cases.satisfied.evidence.or symbol.: is not a key of the output contract grammar",
    ]);
    const quoted = implementFrontmatter.replace(
      "description: A test name, file path, command, or symbol.",
      "description: \"A test name, file path, command, or symbol.\"",
    );
    const compiled = compileOutput(decoded(frontmatterOutput(quoted).output));
    expect(compiled.fields.map(({ key, type, optional }) => ({ key, type, optional }))).toEqual([
      { key: "decisions", type: "list", optional: true },
      { key: "contract_result", type: "object", optional: true },
    ]);
  });
});
