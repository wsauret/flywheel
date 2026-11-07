import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CAPABILITY_PHRASES, findCapabilityTableDrift, findCapabilityTermViolations, realCapabilityVocabulary } from "../../../scripts/capability-terms.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import { SHIPPED_MODULES } from "../../../src/orchestration/modules.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
// One vocabulary of the real catalog for every case: building it reads every bundled definition once.
const vocabulary = await realCapabilityVocabulary(REPO_ROOT, [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES]);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The findings of the rule over a tree that holds only `files`, at their repository paths. */
async function findings(files: { readonly [path: string]: string }): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "flywheel-capability-terms-test-"));
  roots.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
  }
  return (await findCapabilityTermViolations(root, vocabulary)).map((finding) => `${finding.path}:${finding.line} ${finding.module}`);
}

// Each mutation restores a reference that the prompt inventory found and an earlier unit removed; its corrected form
// is the shape the owner now has.
const MUTATIONS = [
  {
    name: "process wait guidance that names workflows",
    path: "src/orchestration/agent-runtime/tools/process.ts",
    bad: 'export const WAIT = "Wait for every managed process, especially subagents and workflows.";\n',
    corrected: 'export const wait = (has: (term: string) => boolean) => has("workflow") ? "Wait for every managed process, especially subagents and workflows." : "Wait for every managed process.";\n',
    module: "workflows",
  },
  {
    name: "orchestration guidance that routes a choice to ask_user",
    path: "src/orchestration/modules/workflows/orchestration.ts",
    bad: 'export const CHOICE = "When a choice needs the person, ask with `ask_user` before you continue.";\n',
    corrected: 'export const choice = (has: (term: string) => boolean) => has("ask_user") ? "When a choice needs the person, ask with `ask_user` before you continue." : "When a choice needs the person, ask in your reply before you continue.";\n',
    module: "ask-user",
  },
  {
    name: "a truncation hint that names the search tool",
    path: "src/orchestration/agent-runtime/compaction/truncation.ts",
    bad: `export const HINT = \`Output truncated. Use the search tool on \${'file'} to find the part you need.\`;\n`,
    corrected: `export const HINT = \`Output truncated. Find the part you need in \${'file'}.\`;\n`,
    module: "discovery",
  },
  {
    name: "the design skill's ask_user route",
    path: "src/agent-skills/design/SKILL.md",
    bad: "# Design\n\nWhen the person must decide, ask with `ask_user` and wait for the answer.\n",
    corrected: "# Design\n\n{{if:ask_user}}\nWhen the person must decide, ask with `ask_user` and wait for the answer.\n{{else}}\nWhen the person must decide, ask in your reply and wait for the answer.\n{{end}}\n",
    module: "ask-user",
  },
] as const;

describe("capability-term rule", () => {
  for (const mutation of MUTATIONS) {
    test(`flags ${mutation.name} and passes its corrected form`, async () => {
      const [bad] = await findings({ [mutation.path]: mutation.bad });
      expect(bad).toStartWith(`${mutation.path}:`);
      expect(bad).toEndWith(` ${mutation.module}`);
      expect(await findings({ [mutation.path]: mutation.corrected })).toEqual([]);
    });
  }

  test("flags a capability named in the else branch of a marker block", async () => {
    const path = "src/agent-skills/design/SKILL.md";
    expect(await findings({ [path]: "{{if:subagent}}\nDispatch the work.\n{{else}}\nAsk with `ask_user`.\n{{end}}\n" })).toEqual([`${path}:4 ask-user`]);
  });

  // Each guard below renders its text where the capability it names may be off; the rule passes a mention only
  // where its guard proves the capability on.
  const TOOL_TEXT = "src/orchestration/agent-runtime/tools/guidance.ts";
  const UNGUARDED = [
    { name: "the false branch of a ternary", line: 1, source: 'export const t = (has: (t: string) => boolean) => has("bash") ? "Run it." : "Run it with the bash tool.";\n' },
    { name: "the text after a guard clause that exits where the capability holds", line: 3, source: 'export function t(has: (t: string) => boolean) {\n  if (has("bash")) return "Run it.";\n  return "Run it with the bash tool.";\n}\n' },
    { name: "a sibling argument of a call", line: 1, source: 'export const t = (set: (k: string, v: string) => void) => set("bash", "Run it with the bash tool.");\n' },
    { name: "error advice that names a capability its guard did not test", line: 2, source: 'export function t(has: (t: string) => boolean) {\n  if (!has("read")) return { error: "Reading is off. Use the bash tool instead." };\n  return { content: "ok" };\n}\n' },
  ];
  for (const { name, line, source } of UNGUARDED) {
    test(`flags a mention in ${name}`, async () => {
      expect(await findings({ [TOOL_TEXT]: source })).toEqual([`${TOOL_TEXT}:${line} bash`]);
    });
  }

  test("passes a mention where its guard proves the capability on, and a refusal that names the capability its guard found off", async () => {
    expect(await findings({
      [TOOL_TEXT]: [
        'export const a = (has: (t: string) => boolean) => has("bash") ? "Run it with the bash tool." : "Run it.";',
        'export function b(has: (t: string) => boolean) {\n  if (!has("bash")) return "Run it.";\n  return "Run it with the bash tool.";\n}',
        'export function c(has: (t: string) => boolean) {\n  if (!has("bash")) return { error: "The bash tool is off." };\n  return { content: "ok" };\n}',
        'export const d = (has: (t: string) => boolean) => has("bash") && has("read") ? "Use the bash tool and the read tool." : "Work in the reply.";',
      ].join("\n"),
    })).toEqual([]);
  });

  test("a marker whose terms hold one at a time guarantees only what every term needs", async () => {
    const path = "src/agent-skills/design/SKILL.md";
    expect(await findings({ [path]: "{{if:ask_user|bash}}\nAsk with `ask_user`.\n{{end}}\n" })).toEqual([`${path}:2 ask-user`]);
  });

  test("matches a tool name in a code span, and passes a span that its syntax names as grammar", async () => {
    const path = "src/agent-skills/design/SKILL.md";
    expect(await findings({ [path]: "Open it with `read`.\n" })).toEqual([`${path}:1 file-tools`]);
    expect(await findings({ [path]: "Set the `write` key, use one of `subagent` or `headless`, and run the `code` command.\n\n| Type | Keys |\n|---|---|\n| `list` | `of` |\n" })).toEqual([]);
  });

  test("passes the capability in its own module's home, and in a thrown refusal whose guard found it off", async () => {
    expect(await findings({
      "src/orchestration/modules/workflows/launch.ts": 'export const TEXT = "Write a workflow file, then launch a workflow with it.";\n',
      "src/orchestration/agent-runtime/tools/refusal.ts": 'export function refuse(has: (t: string) => boolean): void { if (!has("workflow")) throw new Error("No workflow file can launch here."); }\n',
    })).toEqual([]);
  });

  test("finds no drift in the real table, and reports a missing entry, an unknown key, and a missing source", () => {
    expect(findCapabilityTableDrift(REPO_ROOT, CAPABILITY_PHRASES, vocabulary.modules)).toEqual([]);
    expect(findCapabilityTableDrift(REPO_ROOT, { gizmo: { phrases: [], sources: ["src/missing.ts"] } }, [{ id: "widget", tools: ["widget_tool"] }, { id: "gizmo", tools: [] }])).toEqual([
      'capability phrase table has no entry for module "widget", which contributes tools',
      'capability phrase table lists src/missing.ts as text of "gizmo", and it does not exist',
    ]);
    expect(findCapabilityTableDrift(REPO_ROOT, { gizmo: { phrases: [] } }, [])).toEqual(['capability phrase table names "gizmo", which is not an installed module']);
    expect(findCapabilityTableDrift(REPO_ROOT, { gizmo: { phrases: [], harnesses: ["src/orchestration/modules/development/benchmark"] } }, [{ id: "gizmo", tools: [] }])).toEqual([
      'capability phrase table lists src/orchestration/modules/development/benchmark as a harness of "gizmo", and it is not a directory in that module\'s home',
    ]);
  });
});
