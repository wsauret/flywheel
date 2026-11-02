import { describe, expect, test } from "bun:test";
import { Result, Schema, SchemaIssue } from "effect";
import { compileInput, compileOutput, decodeWorkflowInput, type CompiledOutput } from "../../../../src/workflows/output-contract/compile.js";
import { decodeInputObject, type OutputObject } from "../../../../src/workflows/output-contract/grammar.js";

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function decodeIssues<Payload>(compiled: CompiledOutput<Payload>, payload: unknown): string[] {
  const result = Schema.decodeUnknownResult(compiled.schema, { errors: "all" })(payload);
  if (Result.isSuccess(result)) return [];
  return formatIssues(result.failure.issue).issues.map((entry) => {
    const path = (entry.path ?? []).map((segment) => String(typeof segment === "object" ? segment.key : segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${entry.message}`;
  });
}

const directives = {
  type: "list",
  min: 1,
  max: 2,
  unique: "id",
  description: "One entry for each plan directive.",
  of: {
    type: "variant",
    tag: "status",
    cases: {
      satisfied: { id: { type: "string", description: "The directive id." }, evidence: { type: "string", description: "A test name." } },
      deviated: { id: { type: "string", description: "The directive id." }, evidence: { type: "string", description: "What was built instead." }, risk: { type: "enum", values: ["low", "high"], description: "Risk." } },
    },
  },
} as const;

const contract = {
  summary: "What the step did.",
  fields: {
    hypothesis: { type: "string", nullable: true, description: "The root cause, or null." },
    notes: { type: "list", of: { type: "string" }, optional: true, description: "Notes." },
    report: { type: "path", description: "The report file.", example: "docs/report.md" },
    contract_result: { type: "object", optional: true, description: "The directive ledger.", fields: { directives } },
  },
} as const satisfies OutputObject;

const valid = {
  summary: "Done.",
  hypothesis: null,
  report: "docs/report.md",
  contract_result: { directives: [{ status: "satisfied", id: "d1", evidence: "a test" }] },
};

describe("compileOutput strict schema", () => {
  const compiled = compileOutput(contract);

  test("accepts a payload with the declared keys, nullable null, and optional keys absent", () => {
    expect(decodeIssues(compiled, valid)).toEqual([]);
    expect(decodeIssues(compiled, { ...valid, notes: ["a"], files_modified: ["src/a.ts"] })).toEqual([]);
  });

  test("rejects unknown top-level keys with the summary remedy, in the same report as other issues", () => {
    expect(decodeIssues(compiled, { ...valid, warnings: [], extra: 1 })).toEqual([
      "(root): unknown top-level fields: warnings, extra. Put this content in summary.",
    ]);
    expect(decodeIssues(compiled, { ...valid, hypothesis: 3, warnings: [] })).toEqual([
      "hypothesis: Expected string | null, got 3",
      "(root): unknown top-level fields: warnings. Put this content in summary.",
    ]);
  });

  test("rejects unknown keys inside nested objects", () => {
    expect(decodeIssues(compiled, { ...valid, contract_result: { directives: valid.contract_result.directives, note: "x" } })).toEqual([
      "contract_result.note: is not declared by the output contract",
    ]);
  });

  test("requires non-nullable and non-optional keys, and non-empty strings", () => {
    expect(decodeIssues(compiled, { summary: " ", report: "a.md" })).toEqual([
      "summary: expected a non-empty string",
      "hypothesis: Missing key",
    ]);
  });

  test("enforces each variant case with exact keys", () => {
    const withDirective = (directive: { readonly [key: string]: string }) => ({ ...valid, contract_result: { directives: [directive] } });
    expect(decodeIssues(compiled, withDirective({ status: "deviated", id: "d1", evidence: "x" }))).toEqual([
      "contract_result.directives.0.risk: Missing key",
    ]);
    expect(decodeIssues(compiled, withDirective({ status: "satisfied", id: "d1", evidence: "x", risk: "low" }))).toEqual([
      "contract_result.directives.0.risk: is not declared by the output contract",
    ]);
    expect(decodeIssues(compiled, withDirective({ status: "skipped", id: "d1" }))).toEqual([
      'contract_result.directives.0: expected "status" to be one of: satisfied, deviated',
    ]);
  });

  test("enforces list min, max, and unique", () => {
    const withDirectives = (list: readonly { readonly [key: string]: string }[]) => ({ ...valid, contract_result: { directives: list } });
    const satisfied = (id: string) => ({ status: "satisfied", id, evidence: "x" });
    expect(decodeIssues(compiled, withDirectives([]))).toEqual(["contract_result.directives: Expected a value with a length of at least 1, got []"]);
    expect(decodeIssues(compiled, withDirectives([satisfied("a"), satisfied("b"), satisfied("c")])).join("\n")).toContain("at most 2");
    expect(decodeIssues(compiled, withDirectives([satisfied("a"), satisfied("a")]))).toEqual(['contract_result.directives: each item must have a different "id"']);
  });

  test("accepts native path strings without imposing workspace containment", () => {
    for (const report of ["/scratch/report.md", "C:\\work\\report.md", "\\\\server\\share\\report.md", "docs\\report.md", "../report.md"]) {
      expect(decodeIssues(compiled, { ...valid, report })).toEqual([]);
    }
    expect(decodeIssues(compiled, { ...valid, report: " " })).toEqual(["report: expected a non-empty string"]);
  });

  test("requires commands_run when the contract sets commands.min, and checks the record keys", () => {
    const cited = compileOutput({ commands: { min: 1 } });
    expect(decodeIssues(cited, { summary: "Done." })).toEqual(["commands_run: Missing key"]);
    expect(decodeIssues(cited, { summary: "Done.", commands_run: [{ toolUseId: "t1", exitCode: 0, observation: "ok", command: "bun test" }] })).toEqual([]);
    expect(decodeIssues(cited, { summary: "Done.", commands_run: [{ toolUseId: "t1", exitCode: 0, observation: "ok", command: "bun test", cmd: "x" }] }))
      .toEqual(["commands_run.0.cmd: is not declared by the output contract"]);
    expect(decodeIssues(compileOutput({}), { summary: "Done." })).toEqual([]);
  });

  test("a file submission carries only summary and the declared fields", () => {
    const file = compileOutput({ submit: "file", summary: "The plan.", fields: { phases: { type: "list", of: { type: "string" }, description: "Phases." } } });
    expect(file.mode).toBe("file");
    expect(decodeIssues(file, { summary: "Plan.", phases: ["one"] })).toEqual([]);
    expect(decodeIssues(file, { summary: "Plan.", phases: ["one"], commands_run: [] })).toEqual([
      "(root): unknown top-level fields: commands_run. Put this content in summary.",
    ]);
  });
});

describe("compileOutput toolInput", () => {
  const forms = {
    absent: {},
    commands: { commands: { min: 2 } },
    declared: contract,
    file: { submit: "file", summary: "The plan.", fields: { phases: { type: "list", of: { type: "string" }, description: "Phases." } } },
    variant: { fields: { choice: directives.of.cases.satisfied.id, rows: directives } },
  } as const satisfies { readonly [name: string]: OutputObject };

  for (const [name, output] of Object.entries(forms)) {
    test(`the ${name} form has one type: object root`, () => {
      const { toolInput } = compileOutput(output);
      expect(toolInput.type).toBe("object");
      expect(toolInput.additionalProperties).toBe(false);
    });
  }

  test("a variant preserves each case's tag, fields, descriptions, and required keys", () => {
    const { toolInput } = compileOutput({ fields: { rows: directives } });
    const rows: unknown = toolInput.properties && typeof toolInput.properties === "object" ? Object.entries(toolInput.properties).find(([key]) => key === "rows")?.[1] : undefined;
    expect(rows).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        oneOf: [
          {
            type: "object",
            required: ["status", "id", "evidence"],
            additionalProperties: false,
            properties: {
              status: { type: "string", const: "satisfied" },
              id: { type: "string", description: "The directive id." },
              evidence: { type: "string", description: "A test name." },
            },
          },
          {
            type: "object",
            required: ["status", "id", "evidence", "risk"],
            additionalProperties: false,
            properties: {
              status: { type: "string", const: "deviated" },
              id: { type: "string", description: "The directive id." },
              evidence: { type: "string", description: "What was built instead." },
              risk: { type: "string", enum: ["low", "high"], description: "Risk." },
            },
          },
        ],
      },
    });
  });

  test("inline tool input requires summary, asks for citations without the keys the runtime records, and file mode asks for a path", () => {
    const inline = compileOutput({ commands: { min: 1 } }).toolInput;
    expect(inline.type).toBe("object");
    expect(inline.required).toEqual(["summary", "commands_run"]);
    expect(inline).toMatchObject({ properties: { commands_run: { type: "array", items: { type: "object", required: ["toolUseId", "observation"], additionalProperties: false } } } });
    expect(inline).toHaveProperty(["properties", "commands_run", "items", "properties"], { toolUseId: expect.any(Object), observation: expect.any(Object) });
    expect(compileOutput({}).toolInput.required).toEqual(["summary"]);
    expect(compileOutput({ submit: "file" }).toolInput).toMatchObject({ required: ["path"], properties: { path: { type: "string" } } });
  });

  test("commands.min reaches the model as minItems and as an at-least qualifier", () => {
    const compiled = compileOutput({ commands: { min: 3 } });
    expect(compiled.toolInput).toMatchObject({ properties: { commands_run: { type: "array", minItems: 3 } } });
    expect(compiled.instructions).toContain("- **commands_run** (REQUIRED, list of object, at least 3):");
    // The citation check states the count with the calls the worker can cite, so the strict schema does not repeat it.
    expect(decodeIssues(compiled, { summary: "Done.", commands_run: [{ toolUseId: "t1", exitCode: 0, observation: "ok", command: "bun test" }] })).toEqual([]);
  });

  test("each variant case keeps its own nullability and optional keys", () => {
    const { toolInput } = compileOutput({ fields: { choice: { type: "variant", tag: "k", description: "A choice.", cases: {
      x: { a: { type: "string", description: "Text." } },
      y: { a: { type: "string", nullable: true, description: "Text or null." }, b: { type: "number", optional: true, description: "A count." } },
    } } } });
    expect(toolInput).toMatchObject({ properties: { choice: { description: "A choice.", oneOf: [
      { required: ["k", "a"], properties: { k: { const: "x" }, a: { type: "string", description: "Text." } } },
      { required: ["k", "a"], properties: {
        k: { const: "y" },
        a: { type: ["string", "null"], description: "Text or null." },
        b: { type: "number", description: "A count." },
      } },
    ] } } });
  });

  test("a nullable field admits null in the tool schema", () => {
    expect(compileOutput(contract).toolInput).toMatchObject({ properties: { hypothesis: { type: ["string", "null"] } } });
    const nullableVariant = compileOutput({ fields: { choice: { ...directives.of, nullable: true } } });
    expect(nullableVariant.toolInput).toMatchObject({ properties: { choice: { anyOf: [
      { oneOf: [{ properties: { status: { const: "satisfied" } } }, { properties: { status: { const: "deviated" } } }] },
      { type: "null" },
    ] } } });
  });
});

describe("compileOutput identity and control fields", () => {
  test("schemaSha256 ignores descriptions and examples, and sha256 does not", () => {
    const base = compileOutput(contract);
    const reworded = compileOutput({
      ...contract,
      summary: "Another summary text.",
      fields: { ...contract.fields, report: { type: "path", description: "Where the report lives.", example: "other.md" } },
    });
    expect(reworded.schemaSha256).toBe(base.schemaSha256);
    expect(reworded.sha256).not.toBe(base.sha256);
  });

  test("schemaSha256 changes when a type changes", () => {
    const base = compileOutput(contract);
    const retyped = compileOutput({ ...contract, fields: { ...contract.fields, report: { type: "string", description: "The report file." } } });
    expect(retyped.schemaSha256).not.toBe(base.schemaSha256);
    expect(compileOutput({ ...contract, commands: { min: 1 } }).schemaSha256).not.toBe(base.schemaSha256);
  });

  test("fields lists the declared top-level fields for control validation", () => {
    expect(compileOutput({ fields: { rows: directives } }).fields).toEqual([
      { key: "rows", type: "list", optional: false, nullable: false, of: directives.of, unique: "id", max: directives.max },
    ]);
    expect(compileOutput({}).fields).toEqual([]);
  });
});

describe("compileOutput instructions", () => {
  test("renders the postamble for a representative contract", () => {
    const { instructions } = compileOutput({ ...contract, commands: { min: 1 } });
    expect(instructions).toMatchSnapshot();
    expect(instructions).not.toContain("exitCode");
    for (const simple of [compileOutput({}), compileOutput({ commands: { min: 1 } })]) {
      const json = /```json\n([\s\S]*?)\n```/u.exec(simple.instructions)?.[1];
      if (!json) throw new Error("Missing handoff example");
      const example = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(json));
      expect(simple.toolInput.required).toEqual(Object.keys(example));
    }
  });

  test("lets the key of a field without a description state its meaning in the postamble and the tool schema", () => {
    const compiled = compileOutput({ fields: { root_cause: { type: "string" }, choice: { type: "variant", tag: "kind", cases: { a: { note: { type: "string" } } } } } });
    expect(compiled.instructions).toContain("- **root_cause** (REQUIRED, string)\n");
    expect(compiled.instructions).toContain("  - **note** (REQUIRED, string)\n");
    expect(compiled.toolInput).toHaveProperty(["properties", "root_cause"], { type: "string" });
    expect(compiled.toolInput).toHaveProperty(["properties", "choice", "oneOf", 0, "properties", "note"], { type: "string" });
  });

  test("renders the file procedure and no command rule for a file submission", () => {
    const { instructions } = compileOutput({ submit: "file", summary: "The plan.", fields: { phases: { type: "list", of: { type: "string" }, description: "Phases." } } });
    expect(instructions).toContain('call `handoff` with only `{"path": "<absolute path of that file>"}`');
    // The file goes where the handoff accepts it: the agent's own scratchpad.
    expect(instructions).toContain("named `output.json` directly inside your scratchpad directory");
    expect(instructions).not.toContain("Command execution is recorded");
    expect(instructions).not.toContain("commands_run");
  });
});

describe("workflow input contracts", () => {
  const targets = {
    type: "list",
    max: 2,
    unique: "id",
    description: "The targets.",
    of: { type: "object", fields: { id: { type: "string", description: "Target id." }, weight: { type: "number", description: "Weight.", optional: true } } },
  } as const;
  const input = compileInput({ fields: { targets, mode: { type: "enum", values: ["fast", "full"], description: "Mode." } } });

  test("declares fields only: the output envelope keys are refused with their key", () => {
    expect(Result.isSuccess(decodeInputObject({ fields: { targets } }))).toBe(true);
    const refused = decodeInputObject({ summary: "Result.", submit: "file", fields: { targets } });
    expect(Result.isFailure(refused) && refused.failure.join("\n")).toMatch(/^summary: [^\n]+\nsubmit: /);
  });

  test("states one object JSON Schema and pins the accepted shape, not its words", () => {
    expect(input.jsonSchema).toMatchObject({ type: "object", required: ["targets", "mode"], properties: { targets: { type: "array", maxItems: 2 } } });
    expect(input.fields.map(({ key }) => key)).toEqual(["targets", "mode"]);
    const reworded = compileInput({ fields: { targets: { ...targets, description: "Other words." }, mode: { type: "enum", values: ["fast", "full"], description: "Other." } } });
    expect(reworded.schemaSha256).toBe(input.schemaSha256);
    expect(compileInput({ fields: { targets } }).schemaSha256).not.toBe(input.schemaSha256);
  });

  test("decodes strictly and locates every failure under input", () => {
    expect(decodeWorkflowInput(input, { targets: [{ id: "a" }], mode: "fast" })).toEqual(Result.succeed({ targets: [{ id: "a" }], mode: "fast" }));
    const failures = (value: unknown): readonly string[] => {
      const decoded = decodeWorkflowInput(input, value);
      return Result.isFailure(decoded) ? decoded.failure : [];
    };
    expect(failures({ targets: [{ id: "a" }] })).toEqual([expect.stringMatching(/^input\.mode: /)]);
    expect(failures({ targets: [{ id: 1 }], mode: "fast" })).toEqual([expect.stringMatching(/^input\.targets\.0\.id: /)]);
    expect(failures({ targets: [{ id: "a" }, { id: "b" }, { id: "c" }], mode: "fast" })).toEqual([expect.stringMatching(/^input\.targets: .*2/)]);
    expect(failures({ targets: [{ id: "a" }, { id: "a" }], mode: "fast" })).toEqual([expect.stringMatching(/^input\.targets.*: .*id/)]);
    expect(failures({ targets: [], mode: "fast", extra: true })).toEqual([expect.stringMatching(/^input(\.extra)?: /)]);
    expect(failures({ targets: [{ id: "a", extra: 1 }], mode: "fast" })).toEqual(["input.targets.0.extra: is not declared by the input contract"]);
    expect(failures({})).toHaveLength(2);
  });
});
