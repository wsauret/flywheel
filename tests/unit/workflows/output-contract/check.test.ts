import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateAgentOutput } from "../../../../src/workflows/output-contract/accept.js";
import { compileOutput, type OutputCheckContext } from "../../../../src/workflows/output-contract/compile.js";
import {
  canonicalizeCommandRuns,
  checkCommandCitations,
  describeCommandRunRepair,
  isRecordedCommandRunPath,
  resolveCommandRuns,
  type CommandEvidence,
} from "../../../../src/workflows/output-contract/evidence.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

const ledger: readonly CommandEvidence[] = [
  { toolUseId: "toolu_test", command: "bun test", cwd: "/repo", exitCode: 0, changedAfter: ["src/a.ts"], executionMode: "foreground" },
  { toolUseId: "toolu_lint", command: "bun run lint", cwd: "/repo/web", exitCode: 1, changedAfter: [], executionMode: "foreground" },
  { toolUseId: "toolu_serve", command: "bun run serve", cwd: "/repo", exitCode: undefined, changedAfter: [], executionMode: "background" },
];

const readLedger = async () => ledger;

function context(executionCwd: string): OutputCheckContext {
  return { executionCwd, pathExists: async (file) => existsSync(file), readCommandEvidence: readLedger };
}

describe("check path probes", () => {
  const compiled = compileOutput({
    fields: {
      report: { type: "path", description: "The report." },
      draft: { type: "path", exists: false, description: "A file that may not exist yet." },
      sources: { type: "list", of: { type: "path" }, description: "Sources." },
      choice: {
        type: "variant",
        tag: "kind",
        optional: true,
        description: "A choice.",
        cases: { file: { at: { type: "path", nullable: true, description: "A path." } }, none: {} },
      },
    },
  });

  test("preserves absolute and relative artifact paths while checking existence", async () => {
    const parent = temporaryDirectory("output-contract-paths-");
    const root = join(parent, "workspace");
    const proof = join(parent, "proof.md");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "report.md"), "report");
    writeFileSync(proof, "proof");
    const payload = {
      summary: "Done.",
      report: proof,
      draft: "docs/not-yet.md",
      sources: ["docs/report.md", "../proof.md", "docs/missing.md"],
      choice: { kind: "file", at: "docs/gone.md" },
    };
    const checked = await validateAgentOutput(compiled, payload, context(root));
    expect(checked.issues).toEqual([
      { path: "sources.2", message: "referenced artifact does not exist: docs/missing.md" },
      { path: "choice.at", message: "referenced artifact does not exist: docs/gone.md" },
    ]);
    expect(checked.payload.report).toBe(proof);
    expect(checked.payload.sources).toEqual(payload.sources);
    expect((await validateAgentOutput(compiled, { ...payload, sources: ["../proof.md"], choice: { kind: "file", at: null } }, context(root))).issues).toEqual([]);
    expect(await compiled.check({ summary: "Done.", report: "", sources: [null] }, context(root))).toEqual([]);
  });
});

describe("one citation path", () => {
  test("canonicalizes command-run aliases at the top level, and the canonical key wins", () => {
    expect(canonicalizeCommandRuns({
      summary: "Done.",
      commands_run: [{ tool_use_id: "toolu_test", exit_code: 0, note: "ok", cmd: "x" }, { toolUseId: "keep", tool_use_id: "drop" }, "raw"],
    })).toEqual({
      summary: "Done.",
      commands_run: [{ toolUseId: "toolu_test", exitCode: 0, observation: "ok", command: "x" }, { toolUseId: "keep" }, "raw"],
    });
  });

  test("records each cited command, directory, exit code, and later file changes from the ledger, ignores the values the model sent, and reads the ledger only when a record cites a call", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return ledger;
    };
    expect(await resolveCommandRuns({ summary: "Done." }, read)).toEqual({ payload: { summary: "Done." }, repairs: [] });
    expect(reads).toBe(0);
    const resolved = await resolveCommandRuns({ summary: "Done.", commands_run: [
      { toolUseId: "toolu_lint", exitCode: 0, cwd: "/elsewhere", observation: "2 errors" },
      { toolUseId: "toolu_test", command: "typed", changedAfter: [], observation: "12 pass" },
    ] }, read);
    expect(resolved).toEqual({
      payload: { summary: "Done.", commands_run: [
        { toolUseId: "toolu_lint", command: "bun run lint", cwd: "/repo/web", exitCode: 1, changedAfter: [], observation: "2 errors" },
        { toolUseId: "toolu_test", command: "bun test", cwd: "/repo", exitCode: 0, changedAfter: ["src/a.ts"], observation: "12 pass" },
      ] },
      repairs: [
        { kind: "ignored_field", index: 0, field: "exitCode" },
        { kind: "ignored_field", index: 0, field: "cwd" },
        { kind: "ignored_field", index: 1, field: "command" },
        { kind: "ignored_field", index: 1, field: "changedAfter" },
      ],
    });
    expect(reads).toBe(1);
  });

  test("keeps the first citation of a repeated call and leaves out a citation of no completed foreground shell call", async () => {
    const resolved = await resolveCommandRuns({ commands_run: [
      { toolUseId: "toolu_test", observation: "ok" },
      { toolUseId: "toolu_none", observation: "made up" },
      { toolUseId: "toolu_test", observation: "again" },
      { toolUseId: "toolu_serve", observation: "started" },
      { observation: "no id" },
      3,
    ] }, readLedger);
    expect(resolved).toEqual({
      payload: { commands_run: [
        { toolUseId: "toolu_test", command: "bun test", cwd: "/repo", exitCode: 0, changedAfter: ["src/a.ts"], observation: "ok" },
        { observation: "no id" },
        3,
      ] },
      repairs: [
        { kind: "dropped_citation", index: 1, toolUseId: "toolu_none" },
        { kind: "repeated_citation", index: 2, toolUseId: "toolu_test", first: 0 },
        { kind: "dropped_citation", index: 3, toolUseId: "toolu_serve" },
      ],
    });
    expect(resolved.repairs.map(describeCommandRunRepair)).toEqual([
      "Note: `commands_run.1` cited `toolu_none`, which is not a completed foreground shell command call of this attempt, so it was left out.",
      "Note: `commands_run.2` cited `toolu_test` again, so it was left out; `commands_run.0` keeps its observation.",
      "Note: `commands_run.3` cited `toolu_serve`, which is not a completed foreground shell command call of this attempt, so it was left out.",
    ]);
    expect(describeCommandRunRepair({ kind: "ignored_field", index: 0, field: "exitCode" }))
      .toBe("Note: `commands_run.0.exitCode` was ignored; the runtime records it from the cited call.");
  });

  test("decodes a stored record of the shape before directories and later changes were recorded, and of the current shape", () => {
    const decode = Schema.decodeUnknownSync(compileOutput({ commands: { min: 1 } }).schema);
    const previous = { summary: "Done.", commands_run: [{ toolUseId: "toolu_lint", command: "bun run lint", exitCode: 1, observation: "2 errors" }] };
    const current = { summary: "Done.", commands_run: [{ ...previous.commands_run[0], cwd: "/repo/web", changedAfter: ["src/a.ts"] }] };
    expect(decode(previous)).toEqual(previous);
    expect(decode(current)).toEqual(current);
  });

  test("recognizes the keys that resolution records", () => {
    expect(isRecordedCommandRunPath(["commands_run", 0, "command"])).toBe(true);
    expect(isRecordedCommandRunPath(["commands_run", 1, "exitCode"])).toBe(true);
    expect(isRecordedCommandRunPath(["commands_run", 0, "observation"])).toBe(false);
    expect(isRecordedCommandRunPath(["artifacts", "commands_run", 0, "command"])).toBe(false);
  });

  test("enforces commands.min with the eligible calls as the hint", async () => {
    expect(await checkCommandCitations({ commands_run: [{ toolUseId: "toolu_lint", command: "bun run lint", exitCode: 1, observation: "2 errors" }] }, 1, readLedger)).toEqual([]);
    expect(await checkCommandCitations({}, 2, readLedger)).toEqual([
      { path: "commands_run", message: "expected at least 2 cited command runs", hint: "Eligible shell command calls: toolu_test (bun test), toolu_lint (bun run lint)" },
    ]);
    expect(await checkCommandCitations({ commands_run: [] }, 1, async () => [])).toEqual([
      { path: "commands_run", message: "expected at least 1 cited command run", hint: "Run the command with the shell tool, then copy the id from the [toolUseId: ...] line that ends its result." },
    ]);
    expect(await checkCommandCitations({ commands_run: "x" }, 0, readLedger)).toEqual([{ path: "commands_run", message: "expected an array of command records" }]);
    expect(await checkCommandCitations({}, 0, undefined)).toEqual([]);
    expect(await checkCommandCitations({}, 1, undefined)).toEqual([{ path: "commands_run", message: "command evidence is unavailable in this validation context" }]);
  });

  test("accepts a wrong exit code, records the real one, and still refuses a list of only unknown citations under commands.min", async () => {
    const cited = compileOutput({ commands: { min: 1 } });
    const root = temporaryDirectory("output-contract-resolution-");
    const accepted = await validateAgentOutput(cited, { summary: "Done.", commands_run: [{ toolUseId: "toolu_lint", exitCode: 0, observation: "2 errors" }] }, context(root));
    expect(accepted).toEqual({
      payload: { summary: "Done.", commands_run: [{ toolUseId: "toolu_lint", command: "bun run lint", cwd: "/repo/web", exitCode: 1, changedAfter: [], observation: "2 errors" }] },
      issues: [],
      repairs: [{ kind: "ignored_field", index: 0, field: "exitCode" }],
    });
    const refused = await validateAgentOutput(cited, { summary: "Done.", commands_run: [
      { toolUseId: "toolu_none", observation: "ok" },
      { toolUseId: "toolu_other", observation: "ok" },
    ] }, context(root));
    expect(refused.issues).toEqual([
      { path: "commands_run", message: "expected at least 1 cited command run", hint: "Eligible shell command calls: toolu_test (bun test), toolu_lint (bun run lint)" },
    ]);
    expect(refused.repairs).toEqual([
      { kind: "dropped_citation", index: 0, toolUseId: "toolu_none" },
      { kind: "dropped_citation", index: 1, toolUseId: "toolu_other" },
    ]);
  });

  test("refuses a malformed record by its own keys and never asks for a key that resolution records", async () => {
    const root = temporaryDirectory("output-contract-malformed-");
    const { issues } = await validateAgentOutput(compileOutput({}), { summary: "Done.", commands_run: [{ observation: "" }, 3] }, context(root));
    expect(issues.map(({ path }) => path)).toEqual(["commands_run.0.toolUseId", "commands_run.0.observation", "commands_run.1"]);
  });

  test("a compiled inline contract runs the citation check with its commands.min, and a file contract does not", async () => {
    const root = temporaryDirectory("output-contract-citations-");
    expect(await compileOutput({ commands: { min: 1 } }).check({ summary: "Done." }, context(root))).toEqual([
      { path: "commands_run", message: "expected at least 1 cited command run", hint: "Eligible shell command calls: toolu_test (bun test), toolu_lint (bun run lint)" },
    ]);
    expect(await compileOutput({ submit: "file" }).check({ summary: "Done.", commands_run: "ignored" }, context(root))).toEqual([]);
  });
});
