// The tests of the workflow audit campaign, which compares Flywheel with Claude Code
// (bench/README.md). All run on the
// cut-tool-args task's fixture, and each arm's chat agent gets the same
// message.
//
// Test 1, the same workflow: each chat agent launches one topology, which
// workflow-audit/test1 writes twice, as a Claude Code workflow script and as a
// Flywheel workflow file. It measures each runtime: step prompts, step
// context, and handoffs.
//
// Test 2, the same task: each chat agent authors its own workflow for one
// audit request. It measures each arm's authoring guidance.
//
// Test 3, the same named shape: each chat agent authors a loop-until-dry
// search and an adversarial vote. It measures each runtime's loops and
// fan-out on a shape that the request fixes.
//
// Tests 4 and 5 are answer tests, not bug hunts, and change no file. Test 4
// asks for one parallel lane per file and a synthesis that traces a
// malformed tool-call argument end to end. Test 5 asks for three drafts,
// three judges that score every draft, and a synthesis. They name no
// shipped bug site; the judge grades each answer against the test's written
// reference answer, workflow-audit/<test>/reference.md.
//
// Tests 6, 7, and 8 ask tests 2, 4, and 5 again without the word
// "workflow" and without a named shape. They measure whether a chat agent
// chooses a workflow on its own, and keep the grading of the test they
// restate.
//
// Tests 9, 10, and 11 are tasks that need no workflow: a quick question, a
// one-line edit, and a conversational opener. They measure whether a chat
// agent that runs substantive work through workflows still works alone on a
// small task. Each has its own written reference answer.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_DIR } from "./harness-paths.js";

/** The task whose fixture every test runs on. */
export const COMPARISON_TASK = "cut-tool-args";

/** The five files that every test reads. The first two hold the fix that
 *  shipped (tasks/cut-tool-args/WHY.md); the other three are their
 *  neighbours on the same path, which hold no shipped bug. */
const COMPARISON_FILES: readonly string[] = [
  "src/orchestration/agent-runtime/llm/json-parse.ts",
  "src/orchestration/agent-runtime/llm/openai-completions.ts",
  "src/orchestration/agent-runtime/llm/anthropic.ts",
  "src/orchestration/agent-runtime/llm/openai-responses.ts",
  "src/orchestration/agent-runtime/llm/heal-messages.ts",
];

/** One site of the shipped fix: a file and the lines, at the task's base
 *  commit, that hold the bug. */
export interface ShippedSite {
  readonly path: string;
  readonly lines: readonly [first: number, last: number];
  readonly bug: string;
}

/** The bug sites of the fix that shipped, at the base commit b6d62468. */
export const SHIPPED_SITES: readonly ShippedSite[] = [
  { path: "src/orchestration/agent-runtime/llm/json-parse.ts", lines: [145, 175], bug: "salvageJson's partial-json tier completes a cut argument prefix into a valid, shortened tool input" },
  { path: "src/orchestration/agent-runtime/llm/openai-completions.ts", lines: [142, 146], bug: "finish_reason length maps to an ordinary max_tokens stop instead of an output overflow" },
];

const TEST1_DIR = join(HARNESS_DIR, "workflow-audit", "test1");
export const TEST1_WORKFLOW = { claudeCode: join(TEST1_DIR, "review.workflow.js"), flywheel: join(TEST1_DIR, "review.workflow.yaml") } as const;
/** The launch input of test 1. */
export function test1Input() {
  return { files: COMPARISON_FILES.map((path) => ({ path })) };
}

/** The test 1 message, in the same words for both arms: only the path of the
 *  file differs, because each arm reads its own kind of file. */
export function test1Message(workflowPath: string): string {
  return `Launch ${workflowPath} with input ${JSON.stringify(test1Input())}; when it completes, reply with its report verbatim.`;
}

/** The answer tests: each asks a question about the five files, not for a bug hunt or a change. */
export const ANSWER_TESTS = ["test4", "test5", "test7", "test8", "test9", "test10", "test11"] as const;
export type AnswerTest = typeof ANSWER_TESTS[number];

/** Whether `test` is an answer test, which records no site grade and is judged against its reference answer. */
export function isAnswerTest(test: string): test is AnswerTest {
  return ANSWER_TESTS.some((known) => known === test);
}

/** The message of an authored test, from workflow-audit/<test>/message.md with the five files listed.
 *  Test 2 leaves the shape to each arm; test 3 names a shape, rounds of finders until a dry round
 *  and then a two-of-three refutation vote, and each arm authors that shape in its own grammar.
 *  Tests 4 and 5 name a shape for an answer that changes no file. */
export async function authoredTestMessage(test: "test2" | "test3" | "test6" | AnswerTest): Promise<string> {
  const template = (await readFile(join(HARNESS_DIR, "workflow-audit", test, "message.md"), "utf8")).trim();
  return template.replace("<paths>", COMPARISON_FILES.join(", "));
}

/** The answer test whose reference an answer test reads: a plain answer test shares the reference of the test it restates. */
const REFERENCE_OF = { test4: "test4", test5: "test5", test7: "test4", test8: "test5", test9: "test9", test10: "test10", test11: "test11" } as const satisfies { readonly [test in AnswerTest]: AnswerTest };

/** The written reference answer of an answer test, workflow-audit/<test>/reference.md: a correct trace
 *  for test 4, for test 5 the real risks and the behavior a good design keeps, and a short answer for
 *  each of tests 9 to 11. Tests 7 and 8 use the references of tests 4 and 5. Line numbers refer to the
 *  fixture's base commit. */
export async function answerReference(test: AnswerTest): Promise<string> {
  return (await readFile(join(HARNESS_DIR, "workflow-audit", REFERENCE_OF[test], "reference.md"), "utf8")).trim();
}

/** Whether `report` names a shipped bug site: the file's name and a line of
 *  the site, in one `name:line` or `name line`, `name lines` form. */
export function namesShippedSite(report: string, site: ShippedSite): boolean {
  const name = site.path.slice(site.path.lastIndexOf("/") + 1).replaceAll(".", "\\.");
  const pattern = new RegExp(`${name}\\D{0,12}?(\\d+)(?:\\s*[-\u2013]\\s*(\\d+))?`, "gu");
  for (const match of report.matchAll(pattern)) {
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first <= site.lines[1] && last >= site.lines[0]) return true;
  }
  return false;
}
