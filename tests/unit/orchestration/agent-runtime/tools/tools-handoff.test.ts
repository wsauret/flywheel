import { Buffer } from "node:buffer";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Result } from "effect";

import { handoffDefinition, createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { RuntimeTool, ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeContext } from "./_fixtures.js";
import { handoffToolSchemaFromOutput } from "../../../../../src/orchestration/workflow-host/handoff-tool-schema.js";
import { compileOutput } from "../../../../../src/workflows/output-contract/compile.js";
import { decodeOutputObject, type OutputObject } from "../../../../../src/workflows/output-contract/grammar.js";
import implementationPlanContract from "../../../../../src/workflows/workflows/contracts/implementation-plan.json" with { type: "json" };
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";
import { createHandoffTracker } from "../../../../../src/orchestration/agent-runtime/agent-loop-handoff.js";

function toolFor(output: OutputObject) {
  return handoffToolSchemaFromOutput(compileOutput(output));
}

const decodedPlan = decodeOutputObject(implementationPlanContract);
if (Result.isFailure(decodedPlan)) throw new Error(decodedPlan.failure.join("\n"));
const implementationPlan = decodedPlan.success;

const validPlan = {
  summary: "A complete implementation specification assembled outside the provider tool call.",
  schema_version: 1,
  context: { constraints: ["verbatim user request"] },
  milestones: [{ id: "milestone-1", goal: "Implement", files: [], tasks: [], verification: "bun run test" }],
  success_criteria: ["done"],
  implementation_contract: {
    directives: [{ id: "d1", text: "Persist the canonical spec.", completion_check: "The captured handoff matches the file." }],
  },
};

const debugFix = {
  summary: "What the fix changed.",
  fields: { fix_description: { type: "string", description: "The change." } },
} as const satisfies OutputObject;

const diagnosis = {
  summary: "What the fix changed.",
  fields: {
    cause: { type: "string", description: "The root cause." },
    red_result: { type: "string", description: "The failing test output." },
    findings: {
      type: "list",
      description: "What the diagnosis found.",
      of: { type: "object", description: "One finding.", fields: { file: { type: "string", description: "The file." }, issue: { type: "string", description: "The issue." } } },
    },
  },
} as const satisfies OutputObject;

/** Runs one handoff call through the dispatcher, as a model's call runs. */
function submit(tool: RuntimeTool, input: { [key: string]: unknown }, ctx: ToolContext) {
  return executePreparedTool(prepareToolCall({ id: "call-handoff", name: "handoff", input }, new Map([["handoff", tool]]), { ok: true }), ctx);
}

describe("handoff tool", () => {
  const temporaryDirectory = temporaryDirectories();

  it("checks the required top-level keys before the contract runs", async () => {
    const captured: { [key: string]: unknown }[] = [];
    const tool = createHandoffTool({ schema: toolFor({ summary: "What was done.", fields: { notes: { type: "string", description: "Notes." } } }) });
    const ctx = makeContext({ handoff: { onContent: (content) => { captured.push(content); } } });

    const missing = await tool.execute({ summary: "done" }, ctx);
    expect(missing.outcome).toBe("error");
    expect(missing.content).toContain("missing required top-level fields: notes");
    expect(captured).toEqual([]);

    const ok = await tool.execute({ summary: "done", notes: "kept" }, ctx);
    expect(ok.outcome).toBe("ok");
    expect(captured).toEqual([{ summary: "done", notes: "kept" }]);
  });

  it("reports every nested schema error of an inline output in one report", async () => {
    let captured: { [key: string]: unknown } | null = null;
    const tool = createHandoffTool({
      schema: toolFor({
        fields: {
          details: {
            type: "object",
            description: "Details.",
            fields: {
              files: { type: "list", of: { type: "string" }, description: "Files." },
              count: { type: "number", description: "Count." },
            },
          },
        },
      }),
    });
    const result = await tool.execute(
      { summary: 1, details: { files: [false], count: "two" } },
      makeContext({ handoff: { onContent: (content) => { captured = content; } } }),
    );

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("- summary: Expected string\n");
    expect(result.content).toContain("- details.files.0: Expected string\n");
    expect(result.content).toContain('- details.count: Expected number\n');
    expect(result.content).toContain("Call handoff again with one JSON object");
    expect(captured).toBeNull();
  });

  it("reads JSON text according to the selected compiled variant case", async () => {
    const tool = createHandoffTool({ schema: toolFor({ fields: {
      result: { type: "variant", tag: "kind", description: "The result.", cases: {
        structured: { value: { type: "object", description: "The structured value.", fields: { count: { type: "number" } } } },
        text: { value: { type: "string", description: "The text value." } },
      } },
    } }) });
    const captured: unknown[] = [];
    const ctx = makeContext({ handoff: { onContent: (content) => { captured.push(content); } } });
    const value = '{"count":2}';

    const structured = await submit(tool, { summary: "Done.", result: { kind: "structured", value } }, ctx);
    expect(structured.outcome).toBe("ok");
    expect(String(structured.content).split("\n")[0]).toBe("Note: the text value of `result.value` was read as an object.");

    const text = await submit(tool, { summary: "Done.", result: { kind: "text", value } }, ctx);
    expect(text.outcome).toBe("ok");
    expect(text.content).toBe("Handoff recorded.");
    expect(captured).toEqual([
      { summary: "Done.", result: { kind: "structured", value: { count: 2 } } },
      { summary: "Done.", result: { kind: "text", value } },
    ]);
  });

  it("refuses output fields beside the path of a file output", async () => {
    const tool = createHandoffTool({ schema: toolFor(implementationPlan) });
    const captured: { [key: string]: unknown }[] = [];
    const ctx = makeContext({ scratchDir: temporaryDirectory("flywheel-file-output-"), handoff: { onContent: (content) => { captured.push(content); } } });

    const bare = await tool.execute({ summary: "inline plan" }, ctx);
    expect(bare.outcome).toBe("error");
    expect(bare.content).toContain("missing required top-level fields: path");
    const mixed = await tool.execute({ path: "/scratch/plan.json", milestones: [] }, ctx);
    expect(mixed.outcome).toBe("error");
    expect(mixed.content).toContain("unknown top-level fields: milestones");
    expect(captured).toEqual([]);
  });

  it("stores the content of a file output, not its path", async () => {
    const scratchRoot = temporaryDirectory("flywheel-file-output-");
    const planPath = join(scratchRoot, "plan.json");
    await writeFile(planPath, JSON.stringify(validPlan));
    const schema = toolFor(implementationPlan);
    const tool = createHandoffTool({ schema });
    const captured: { [key: string]: unknown }[] = [];

    expect(schema.input.properties).toHaveProperty("path");
    expect(schema.input.properties).not.toHaveProperty("milestones");
    const result = await tool.execute({ path: planPath }, makeContext({ scratchDir: scratchRoot, handoff: { onContent: (content) => { captured.push(content); } } }));

    expect(result.outcome).toBe("ok");
    expect(captured).toEqual([validPlan]);
  });

  it("rejects an unreadable or invalid output file without capture", async () => {
    const scratchRoot = temporaryDirectory("flywheel-file-output-invalid-");
    const plansRoot = join(scratchRoot, "plans");
    const outsideRoot = temporaryDirectory("flywheel-file-output-outside-");
    const outsidePath = join(outsideRoot, "outside.json");
    const malformedPath = join(plansRoot, "malformed.json");
    const invalidPath = join(plansRoot, "invalid.json");
    const fieldErrorsPath = join(plansRoot, "field-errors.json");
    const escapePath = join(plansRoot, "escape.json");
    await mkdir(plansRoot);
    await writeFile(outsidePath, JSON.stringify(validPlan));
    await writeFile(malformedPath, "{");
    await writeFile(invalidPath, "{}");
    await writeFile(fieldErrorsPath, JSON.stringify({
      schema_version: 2,
      summary: 1,
      context: { key_files: [false], constraints: ["verbatim user request"] },
      milestones: [{ id: "m1", goal: 2, files: [], tasks: [], verification: "bun run test" }],
      success_criteria: [6],
    }, null, 2));
    await symlink(outsidePath, escapePath);

    const tool = createHandoffTool({ schema: toolFor(implementationPlan) });
    const captured: { [key: string]: unknown }[] = [];
    const ctx = makeContext({ scratchDir: scratchRoot, handoff: { onContent: (content) => { captured.push(content); } } });

    for (const path of ["plans/relative.json", join(plansRoot, "missing.json"), plansRoot, outsidePath, escapePath, malformedPath, invalidPath]) {
      expect((await tool.execute({ path }, ctx)).outcome).toBe("error");
    }
    const outside = await tool.execute({ path: escapePath }, ctx);
    expect(outside.content).toContain(`path: the output file must be inside your scratchpad directory ${scratchRoot}`);
    // An agent that wrote elsewhere before its scratchpad existed learns where
    // the file belongs, not that the scratchpad is missing.
    const absentScratch = join(scratchRoot, "absent");
    const unmade = await tool.execute({ path: outsidePath }, { ...ctx, scratchDir: absentScratch });
    expect(unmade.content).toContain(`path: the output file must be inside your scratchpad directory ${absentScratch}`);
    const malformed = await tool.execute({ path: malformedPath }, ctx);
    expect(malformed.content).toContain("- path: the output file is not valid JSON at line 1, column 2: expected '}'\n> 1 | {\n    |  ^\nFix `path`");
    expect(malformed.content).toContain("edit that JSON file");
    expect(malformed.content).toContain("with only `path`");
    const invalid = await tool.execute({ path: invalidPath }, ctx);
    expect(invalid.content).toContain("`summary`, `schema_version`, `context`, `milestones`, `success_criteria`, `implementation_contract`");
    for (const key of ["summary", "schema_version", "context", "milestones", "success_criteria"]) {
      expect(invalid.content).toContain(`- ${key} (line 1): Missing key`);
    }
    const fieldErrors = await tool.execute({ path: fieldErrorsPath }, ctx);
    expect(fieldErrors.content).toContain("- schema_version (line 2): Expected 1\n");
    expect(fieldErrors.content).toContain("- context.key_files.0 (line 6): Expected string\n");
    expect(fieldErrors.content).toContain("- milestones.0.goal (line 15): Expected string\n");
    expect(fieldErrors.content).toContain("- success_criteria.0 (line 22): Expected string\n");
    expect(captured).toEqual([]);
  });

  it("names the file line of every syntax and schema problem", async () => {
    const scratchRoot = temporaryDirectory("flywheel-file-output-lines-");
    const milestone = (id: string) => ({ id, goal: `Deliver ${id}`, files: ["src/a.ts"], tasks: [{ id: `${id}-task`, description: "Change a.ts", files: ["src/a.ts"], test_scenarios: ["a.ts behaves"] }], verification: "bun run test" });
    const plan = { ...validPlan, milestones: [milestone("milestone-1"), milestone("milestone-1"), milestone("milestone-3")] };
    const lines = JSON.stringify(plan, null, 2).split("\n");
    const verificationLine = lines.findIndex((line, index) => index > 30 && line.includes('"verification"')) + 1;
    lines[verificationLine - 1] = lines[verificationLine - 1]!.replace('"bun run test"', "7");
    const duplicatePath = join(scratchRoot, "duplicate.json");
    await writeFile(duplicatePath, JSON.stringify(plan, null, 2));
    const schemaPath = join(scratchRoot, "schema.json");
    await writeFile(schemaPath, lines.join("\n"));
    const syntaxPath = join(scratchRoot, "syntax.json");
    const commaLine = lines.findIndex((line, index) => index > 20 && line.endsWith(",")) + 1;
    lines[commaLine - 1] = lines[commaLine - 1]!.slice(0, -1);
    await writeFile(syntaxPath, lines.join("\n"));

    const tool = createHandoffTool({ schema: toolFor(implementationPlan) });
    const ctx = makeContext({ scratchDir: scratchRoot, handoff: { onContent: () => {} } });

    const syntax = await tool.execute({ path: syntaxPath }, ctx);
    expect(syntax.outcome).toBe("error");
    expect(syntax.content).toContain(`not valid JSON at line ${commaLine + 1}, column `);
    expect(syntax.content).toContain("expected ',' between items");

    const schema = await tool.execute({ path: schemaPath }, ctx);
    expect(schema.outcome).toBe("error");
    expect(schema.content).toContain(`- milestones.1.verification (line ${verificationLine}): Expected string\n`);

    // A list filter runs only on items that decode, so the duplicate id is
    // reported once the items themselves are valid.
    const milestonesLine = lines.findIndex((line) => line.startsWith('  "milestones"')) + 1;
    const duplicate = await tool.execute({ path: duplicatePath }, ctx);
    expect(duplicate.outcome).toBe("error");
    expect(duplicate.content).toContain(`- milestones (line ${milestonesLine}): each item must have a different "id"`);
  });

  it("accepts an output file at the byte limit and rejects one byte more", async () => {
    const maxBytes = 1_000_000;
    const scratchRoot = temporaryDirectory("flywheel-file-output-size-");
    const exactPath = join(scratchRoot, "exact.json");
    const oversizedPath = join(scratchRoot, "oversized.json");
    const plan = { ...validPlan, summary: "" };
    plan.summary = "x".repeat(maxBytes - Buffer.byteLength(JSON.stringify(plan), "utf8"));
    const exact = JSON.stringify(plan);
    expect(Buffer.byteLength(exact, "utf8")).toBe(maxBytes);
    await writeFile(exactPath, exact);
    await writeFile(oversizedPath, `${exact} `);

    const tool = createHandoffTool({ schema: toolFor(implementationPlan) });
    const captured: { [key: string]: unknown }[] = [];
    const ctx = makeContext({ scratchDir: scratchRoot, handoff: { onContent: (content) => { captured.push(content); } } });

    expect((await tool.execute({ path: exactPath }, ctx)).outcome).toBe("ok");
    expect((await tool.execute({ path: oversizedPath }, ctx)).outcome).toBe("error");
    expect(captured).toEqual([plan]);
  });

  it("probes a path field from the tool working directory", async () => {
    const workspace = temporaryDirectory("flywheel-handoff-cwd-");
    await writeFile(join(workspace, "report.md"), "# Report");
    await mkdir(join(workspace, "probe"));
    const reportField = { fields: { report: { type: "path", description: "The report." } } } as const satisfies OutputObject;
    const tool = createHandoffTool({ schema: toolFor(reportField) });
    const ctx = makeContext({ executionCwd: workspace, handoff: { onContent: () => {} } });

    expect((await tool.execute({ summary: "Wrote the report.", report: "report.md" }, ctx)).outcome).toBe("ok");
    // The decode and the path probe report together.
    const missing = await tool.execute({ summary: 7, report: "missing.md" }, ctx);
    expect(missing.outcome).toBe("error");
    const problems = String(missing.content).split("\n").filter((line) => line.startsWith("- "));
    expect(problems).toHaveLength(2);
    expect(problems).toContain("- summary: Expected string");
    expect(problems.some((line) => line.startsWith("- report: "))).toBe(true);
    // A path field can name an existing directory.
    const directory = await createHandoffTool({ schema: toolFor(reportField) }).execute({ summary: "Probed.", report: "probe" }, ctx);
    expect(directory.outcome).toBe("ok");
  });

  it("captures nothing and asks for another call when the call was cut off before acceptance finished", async () => {
    const cut = new AbortController();
    const schema = toolFor({ summary: "Done." });
    const tool = createHandoffTool({ schema: { ...schema, accept: async (submission, context) => { cut.abort(); return await schema.accept!(submission, context); } } });
    const captured: unknown[] = [];
    const result = await tool.execute({ summary: "done" }, makeContext({ signal: cut.signal, handoff: { onContent: (content) => { captured.push(content); } } }));
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("nothing was recorded. Call handoff again.");
    expect(captured).toEqual([]);
  });

  it("records each cited command and exit code from its execution fact, not from the model, and notes the ignored value first", async () => {
    const tool = createHandoffTool({ schema: toolFor(debugFix) });
    const captured: { [key: string]: unknown }[] = [];
    const ctx = makeContext({
      handoff: {
        onContent: (content) => { captured.push(content); },
        readCommandEvidence: async () => [
          { toolUseId: "tool-1", command: "bun test tests/unit/a.test.ts 2>&1 | tail -20", cwd: "/repo", exitCode: 0, changedAfter: [], executionMode: "foreground" },
          { toolUseId: "tool-2", command: "curl -H 'Authorization: [redacted secret]' localhost", cwd: "/repo", exitCode: 7, changedAfter: [], executionMode: "foreground" },
        ],
      },
    });
    const fix = { summary: "Fixed the defect.", fix_description: "Added the user id to the cache key." };

    const result = await submit(tool, {
      ...fix,
      commands_run: [
        { toolUseId: "tool-1", observation: "3 tests passed" },
        { toolUseId: "tool-2", exitCode: 0, observation: "the endpoint refused the connection" },
      ],
    }, ctx);

    expect(result.outcome).toBe("ok");
    expect(String(result.content).split("\n")).toEqual([
      "Note: `commands_run.1.exitCode` was ignored; the runtime records it from the cited call.",
      "Handoff recorded.",
    ]);
    expect(captured).toEqual([{
      ...fix,
      commands_run: [
        { toolUseId: "tool-1", command: "bun test tests/unit/a.test.ts 2>&1 | tail -20", cwd: "/repo", exitCode: 0, changedAfter: [], observation: "3 tests passed" },
        { toolUseId: "tool-2", command: "curl -H 'Authorization: [redacted secret]' localhost", cwd: "/repo", exitCode: 7, changedAfter: [], observation: "the endpoint refused the connection" },
      ],
    }]);
  });

  it("leaves out a citation of no call of the attempt and refuses only when too few real citations remain", async () => {
    const evidence = async () => [{ toolUseId: "tool-1", command: "bun test", cwd: "/repo", exitCode: 0, changedAfter: [], executionMode: "foreground" as const }];
    const fix = { summary: "Fixed the defect.", fix_description: "Added the user id to the cache key." };
    const dropped = "Note: `commands_run.0` cited `tool-9`, which is not a completed foreground shell command call of this attempt, so it was left out.";
    const captured: { [key: string]: unknown }[] = [];

    const accepted = await createHandoffTool({ schema: toolFor(debugFix) }).execute(
      { ...fix, commands_run: [{ toolUseId: "tool-9", observation: "3 tests passed" }] },
      makeContext({ handoff: { onContent: (content) => { captured.push(content); }, readCommandEvidence: evidence } }),
    );
    expect(accepted.outcome).toBe("ok");
    expect(String(accepted.content).split("\n")[0]).toBe(dropped);
    expect(captured).toEqual([{ ...fix, commands_run: [] }]);

    const refused = await createHandoffTool({ schema: toolFor({ ...debugFix, commands: { min: 1 } }) }).execute(
      { ...fix, commands_run: [{ toolUseId: "tool-9", observation: "3 tests passed" }] },
      makeContext({ handoff: { onContent: () => {}, readCommandEvidence: evidence } }),
    );
    expect(refused.outcome).toBe("error");
    const lines = String(refused.content).split("\n");
    expect(lines[0]).toBe(dropped);
    expect(lines.filter((line) => line.startsWith("- "))).toEqual([
      "- commands_run: expected at least 1 cited command run (Eligible shell command calls: tool-1 (bun test))",
    ]);
  });

  it("returns error when no handoff capture is configured", async () => {
    const result = await handoffDefinition.execute({ summary: "done" }, makeContext());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("no handoff capture");
  });

  it("recovers a collapsed handoff into structured top-level fields", async () => {
    let captured: { [key: string]: unknown } | null = null;
    const ctx = makeContext({ handoff: { onContent: (content) => { captured = content; } } });
    const result = await submit(handoffDefinition, {
      summary:
        "Rewrote the table renderer and verified everything.</summary>\n" +
        '<artifacts>{"files_created": ["a.ts"], "files_modified": ["b.ts"]}</artifacts>\n' +
        '<verification>{"tests_passed": true}</verification>\n' +
        '<decisions>["chose flex layout"]</decisions>\n' +
        "</invoke>\n",
    }, ctx);

    expect(result.outcome).toBe("ok");
    expect<unknown>(captured).toEqual({
      summary: "Rewrote the table renderer and verified everything.",
      artifacts: { files_created: ["a.ts"], files_modified: ["b.ts"] },
      verification: { tests_passed: true },
      decisions: ["chose flex layout"],
    });
  });

  it("splits the declared fields a step's handoff collapsed into one value, in either markup form", async () => {
    const expected = {
      summary: "Fixed the inclusive loop bound.",
      cause: "The loop bound used <= instead of <.",
      red_result: "FAIL tests/range.test.ts > range > counts the last item\nexpected 3, received 4",
      findings: [{ file: "src/range.ts", issue: "inclusive bound" }],
    };
    const findingsJson = '[{"file": "src/range.ts", "issue": "inclusive bound"}]';
    for (const collapsed of [
      {
        summary: expected.summary,
        cause: `${expected.cause}</cause>\n<red_result>${expected.red_result}</red_result>\n<findings>${findingsJson}</findings>\n</invoke>`,
      },
      {
        summary: expected.summary,
        red_result: `${expected.red_result}</parameter>\n<parameter name="cause">${expected.cause}</parameter>\n<parameter name="findings">${findingsJson}</parameter>\n</invoke>`,
      },
    ]) {
      const captured: unknown[] = [];
      const result = await submit(createHandoffTool({ schema: toolFor(diagnosis) }), collapsed, makeContext({ handoff: { onContent: (content) => { captured.push(content); } } }));

      expect(result.outcome).toBe("ok");
      expect(captured).toEqual([expected]);
      const [note] = String(result.content).split("\n");
      expect(note).toStartWith("Note:");
      expect(note).toContain(collapsed.cause === undefined ? "`red_result`" : "`cause`");
      expect(note).toContain("`findings`");
    }
  });

  it("accepts a collapsed field that repeats a top-level value unchanged", async () => {
    const captured: unknown[] = [];
    const result = await submit(createHandoffTool({ schema: toolFor(diagnosis) }), {
      summary: "Fixed it.",
      cause: "Off by one.</cause>\n<red_result>expected 3, received 4</red_result>\n<findings>[]</findings>",
      red_result: "expected 3, received 4",
    }, makeContext({ handoff: { onContent: (content) => { captured.push(content); } } }));

    expect(result.outcome).toBe("ok");
    expect(captured).toEqual([{ summary: "Fixed it.", cause: "Off by one.", red_result: "expected 3, received 4", findings: [] }]);
  });

  it("rejects collapsed handoffs that cannot be safely recovered", async () => {
    const cases: { tool: RuntimeTool; input: { [key: string]: unknown } }[] = [
      // The shape the check exists for: arguments serialized as tags inside one string, ending in the leaked call terminator.
      ...[
        "Did the work.</summary>\n<artifacts>not valid json at all</artifacts>\n</invoke>\n",
        "Did the work.</summary>\n<artifacts>not valid json",
        'Did the work.</parameter>\n<parameter name="files_modified">not json</parameter>',
      ].map((summary) => ({ tool: handoffDefinition, input: { summary } })),
      ...[
        // A tag that names no declared field.
        { summary: "Fixed it.", red_result: "x", findings: [], cause: "Off by one.</cause>\n<notes>see log</notes>" },
        // A recovered field that a top-level key states differently.
        { summary: "Fixed it.", red_result: "top level", findings: [], cause: "Off by one.</cause>\n<red_result>in markup</red_result>" },
        // Text after the fragments that no tag holds.
        { summary: "Fixed it.", findings: [], cause: "Off by one.</cause>\n<red_result>x</red_result>\nand more prose" },
        // A list field whose body is not JSON.
        { summary: "Fixed it.", red_result: "x", cause: "Off by one.</cause>\n<findings>src/range.ts is wrong</findings>" },
      ].map((input) => ({ tool: createHandoffTool({ schema: toolFor(diagnosis) }), input })),
    ];
    for (const { tool, input } of cases) {
      const captured: unknown[] = [];
      const result = await submit(tool, input, makeContext({ handoff: { onContent: (content) => { captured.push(content); } } }));

      expect(result.outcome).toBe("error");
      expect(result.content).toContain("- Your `");
      expect(result.content).toContain("collapsed into a single argument");
      expect(captured).toEqual([]);
    }
  });

  it("accepts tags quoted in prose, which carry no seam between arguments", async () => {
    for (const summary of [
      // A real rejected handoff: the summary quotes the compaction wrapper a harness sends.
      "The injected entry is role `user` with text `A previous instance has summarized the conversation thus far as follows:\\n\\n<summary>\\n(the summary)\\n</summary>\\n\\nIMPORTANT: Files referenced in the summary may not be available.` (`304255-304303`).",
      "Synthetic context: `The following is a summary of a branch:\n\n<summary>...</summary>`; constructed in `messages.ts:19-24`.",
      "I removed the </summary> mention from the docs but kept everything else.",
      "The fix strips the trailing terminator, for example </invoke>",
    ]) {
      const captured: unknown[] = [];
      const result = await handoffDefinition.execute({ summary }, makeContext({ handoff: { onContent: (content) => { captured.push(content); } } }));

      expect(result.outcome).toBe("ok");
      expect(captured).toEqual([{ summary }]);
    }
  });

  it("strips a lone trailing closing tag of the field's own name", async () => {
    const captured: unknown[] = [];
    const result = await submit(
      handoffDefinition,
      { summary: "A valid summary that meets the requirement.</summary>\n" },
      makeContext({ handoff: { onContent: (content) => { captured.push(content); } } }),
    );
    expect(result.outcome).toBe("ok");
    expect(captured).toEqual([{ summary: "A valid summary that meets the requirement." }]);
  });

  it("accepts prose containing comparison angle brackets", async () => {
    let captured: { [key: string]: unknown } | null = null;
    const summary = "Refactored the comparator so a < b and b > c are evaluated correctly.";
    const result = await handoffDefinition.execute(
      { summary },
      makeContext({ handoff: { onContent: (content) => { captured = content; } } }),
    );
    expect(result.outcome).toBe("ok");
    expect<unknown>(captured).toEqual({ summary });
  });

  it("blocks stream-start admission until task and server completion receipts commit", async () => {
    let captured: { [key: string]: unknown } | null = null;
    let receipt = Promise.withResolvers<void>();
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => receipt.promise });
    const commandDone = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: commandDone.promise,
      meta: { id: "command-1", type: "background_command", description: "bun run test:perf" },
    });
    const ctx = makeContext({
      handoff: { onContent: (content) => { captured = content; } },
      backgroundTasks: registry,
    });
    const tracker = createHandoffTracker({ background: registry });
    const attempt = async (summary: string) => {
      const request = tracker.request();
      const call = { id: "handoff", name: "handoff", input: { summary } };
      request.start(call);
      return request.refuse(call) ?? submit(handoffDefinition, call.input, ctx);
    };

    const commandBlocked = await attempt("Premature");
    expect(commandBlocked.outcome).toBe("blocked");
    expect(commandBlocked.content).toContain("bun run test:perf");
    expect(commandBlocked.content).toContain("Wait for each to end, or stop it with the process tool");
    expect(captured).toBeNull();

    commandDone.resolve({ status: "completed", content: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const commandPending = await attempt("Still premature");
    expect(commandPending.outcome).toBe("blocked");
    expect(commandPending.content).toContain("Results still owed");
    expect(captured).toBeNull();
    receipt.resolve();
    await Promise.resolve();
    await Promise.resolve();
    receipt = Promise.withResolvers<void>();

    const reviewerDone = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: reviewerDone.promise,
      meta: { id: "reviewer-1", type: "subagent", description: "Architecture review" },
    });

    const blocked = await attempt("Premature");
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.content).toContain("Still running");
    expect(captured).toBeNull();

    reviewerDone.resolve({ status: "completed", content: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const undelivered = await attempt("Still premature");
    expect(undelivered.outcome).toBe("blocked");
    expect(undelivered.content).toContain("Results still owed");
    expect(captured).toBeNull();

    registry.flushSettledNotifications();
    receipt.resolve();
    await Promise.resolve();
    await Promise.resolve();
    receipt = Promise.withResolvers<void>();
    const serverDone = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({
      done: serverDone.promise,
      meta: { id: "command-2", type: "background_command", description: "python3 server.py" },
    });
    const serverRunning = await attempt("Server still up");
    expect(serverRunning.outcome).toBe("blocked");
    expect(serverRunning.content).toContain("Still running: python3 server.py");
    expect(serverRunning.content).toContain("stop it with the process tool");
    expect(captured).toBeNull();

    serverDone.resolve({ status: "completed", content: "" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    receipt.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const ok = await attempt("Final");
    expect(ok.outcome).toBe("ok");
    expect<unknown>(captured).toEqual({ summary: "Final" });
  });

  it("reports capture callback errors", async () => {
    const result = await handoffDefinition.execute(
      { summary: "test" },
      makeContext({ handoff: { onContent: () => { throw new Error("capture failed"); } } }),
    );
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Failed to record handoff");
    expect(result.content).toContain("capture failed");
  });

  it("blocks Chat stream-start admission until async completion receipts and queued input commit", async () => {
    const mailbox = new ChatTurnMailbox();
    const held = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const done = Promise.withResolvers<BackgroundWorkResult>();
    const captured: unknown[] = [];
    const registry = createBackgroundWorkRegistry({
      kind: "chat", pendingInput: () => mailbox.hasPending,
      enqueueNotification: async (text) => {
        delivered.resolve();
        await held.promise;
        mailbox.enqueueSilentSystem(text);
      },
    });
    registry.track({ done: done.promise, meta: { id: "chat-command", type: "background_command", description: "verification" } });
    const ctx = makeContext({ backgroundTasks: registry, handoff: { onContent: (value) => { captured.push(value); } } });
    const tracker = createHandoffTracker({ background: registry });
    const attempt = async (summary: string) => {
      const request = tracker.request();
      const call = { id: "handoff", name: "handoff", input: { summary } };
      request.start(call);
      return request.refuse(call) ?? submit(handoffDefinition, call.input, ctx);
    };
    expect((await attempt("early")).outcome).toBe("blocked");
    done.resolve({ status: "completed", content: "done" });
    await delivered.promise;
    expect((await attempt("holding")).outcome).toBe("blocked");
    held.resolve();
    await Promise.resolve();
    expect((await attempt("queued")).outcome).toBe("blocked");
    mailbox.drainPending();

    const child = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: child.promise, meta: { id: "child", type: "subagent", description: "review" } });
    expect((await attempt("child active")).outcome).toBe("blocked");
    child.resolve({ status: "completed", content: "review complete" });
    await Promise.resolve();
    await Promise.resolve();
    expect((await attempt("child pending")).outcome).toBe("blocked");
    registry.flushSettledNotifications();
    await Promise.resolve();
    await Promise.resolve();
    mailbox.drainPending();

    const server = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: server.promise, meta: { id: "server", type: "background_command", description: "server" } });
    const blocked = await attempt("server active");
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.content).toContain("Still running: server");
    server.resolve({ status: "completed", content: "" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    mailbox.drainPending();
    expect((await attempt("all done")).outcome).toBe("ok");
    expect(captured).toEqual([{ summary: "all done" }]);
    await registry.terminateAll();
  });
});
