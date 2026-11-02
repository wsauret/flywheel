import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowAuditAnswer, workflowAuditFamily, loadWorkflowAuditTasks, prepareWorkflowAuditProject, workflowAuditGrade, workflowAuditSites } from "../../../bench/chat-ab/workflow-audit-family.js";
import { TEST1_WORKFLOW, test1Message, authoredTestMessage, answerReference, SHIPPED_SITES } from "../../../bench/chat-ab/workflow-audit-tests.js";
import { structuredIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();

test("audit tasks use the same request with only the subject's project workflow path changed", async () => {
  const [prepared, authored, voted] = await loadWorkflowAuditTasks(["test1", "test2", "test3"]);
  expect(workflowAuditFamily.message(prepared!, "control", "flywheel")).toBe(test1Message("review.workflow.yaml"));
  expect(workflowAuditFamily.message(prepared!, "candidate", "claude-code")).toBe(test1Message("review.workflow.js"));
  expect(workflowAuditFamily.message(authored!, "control", "flywheel")).toBe(await authoredTestMessage("test2"));
  expect(workflowAuditFamily.message(authored!, "candidate", "claude-code")).toBe(await authoredTestMessage("test2"));
  for (const subject of ["flywheel", "claude-code"] as const) expect(workflowAuditFamily.message(voted!, "control", subject)).toBe(await authoredTestMessage("test3"));
  expect(await authoredTestMessage("test3")).toContain("until a round finds no new bug");
  await expect(loadWorkflowAuditTasks(["test12"])).rejects.toThrow("Unknown workflow audit test");
});

test("answer tests send one read-only request to both subjects and carry their own reference answer", async () => {
  const [understand, panel] = await loadWorkflowAuditTasks(["test4", "test5"]);
  for (const [task, id] of [[understand!, "test4"], [panel!, "test5"]] as const) {
    const message = await authoredTestMessage(id);
    for (const subject of ["flywheel", "claude-code"] as const) expect(workflowAuditFamily.message(task, "control", subject)).toBe(message);
    expect(message).toContain("Do not change any file in the repository.");
    for (const path of ["json-parse.ts", "openai-completions.ts", "anthropic.ts", "openai-responses.ts", "heal-messages.ts"]) expect(message).toContain(`src/orchestration/agent-runtime/llm/${path}`);
    expect(task.reference).toBe(await answerReference(id));
  }
  expect(await authoredTestMessage("test4")).toContain("Read each file in its own parallel lane");
  expect(await authoredTestMessage("test5")).toContain("three independent judges score every draft on correctness, risk, and size of change");
  expect(understand!.reference).toContain("json-parse.ts:133-143");
  expect(panel!.reference).toContain("What a good design must keep");
});

test("plain tests restate tests 2, 4, and 5 without naming a workflow or a shape, and keep their grading", async () => {
  const [audit, understand, panel] = await loadWorkflowAuditTasks(["test6", "test7", "test8"]);
  for (const task of [audit!, understand!, panel!]) {
    expect(task.message.toLowerCase()).not.toContain("workflow");
    for (const path of ["json-parse.ts", "openai-completions.ts", "anthropic.ts", "openai-responses.ts", "heal-messages.ts"]) expect(task.message).toContain(`src/orchestration/agent-runtime/llm/${path}`);
  }
  expect(audit!.reference).toBeNull();
  expect(understand!.reference).toBe(await answerReference("test4"));
  expect(panel!.reference).toBe(await answerReference("test5"));
  for (const task of [understand!, panel!]) {
    expect(task.message).toContain("Do not change any file in the repository.");
    expect(task.message).not.toContain("parallel lane");
    expect(task.message).not.toContain("judges");
  }
});

test("small tasks that need no workflow carry their own reference answer and name the five files", async () => {
  for (const id of ["test9", "test10", "test11"] as const) {
    const [task] = await loadWorkflowAuditTasks([id]);
    expect(task!.reference).toBe(await answerReference(id));
    expect(task!.message.toLowerCase()).not.toContain("workflow");
    expect(task!.message).toContain("src/orchestration/agent-runtime/llm/heal-messages.ts");
  }
  expect(await authoredTestMessage("test10")).toContain("Change nothing else.");
});

test("bug audit identities stay fixed for recorded campaigns, and an answer test's identity covers its reference", async () => {
  // Campaigns recorded before the answer tests existed validate against these identities. A change here is a
  // deliberate break of every recorded test 1 to 3 campaign.
  // The 2026-10-23 cut-tool-args Challenge section changed WHY.md, so audit campaigns recorded before it do not validate against the new identities.
  // The 2026-10-29 removal of unpublished scratch-path citations from cut-tool-args WHY.md breaks them again.
  // The 2026-10-29 rewrite of the prepared test 1 workflows in the phase grammar breaks them again.
  const tasks = await loadWorkflowAuditTasks(["test1", "test2", "test3"]);
  expect(Object.fromEntries(tasks.map(({ id, contentIdentity }) => [id, contentIdentity]))).toEqual({
    test1: "d349f21c7304340509c5fbd2f240c53922ca0c58b1015ce18c8388cb4a4500b6",
    test2: "717230886d43aaf3111602d1e1a802477160d95ee4a37511c9d369ec6380250d",
    test3: "5bcf977a0786a88b6740eca19fe2ba5366d6f79f93eb292ca34a35543558360c",
  });
  const why = await readFile(join(tasks[0]!.fixture.taskDir, "WHY.md"), "utf8");
  for (const task of await loadWorkflowAuditTasks(["test4", "test5"])) {
    const { id, fixture, message, reference } = task;
    expect(task.contentIdentity).toBe(structuredIdentity({ id, fixture: fixture.contentIdentity, why, message, reference }));
  }
});

test("answer tests record no site grade, even when the answer names a shipped site", async () => {
  const handoff = { summary: "json-parse.ts:162 completes a cut prefix; openai-completions.ts:145 maps length" };
  const [audit, understand, panel] = await loadWorkflowAuditTasks(["test2", "test4", "test5"]);
  expect(workflowAuditSites(audit!, handoff)).toEqual(workflowAuditGrade(handoff));
  expect(Object.values(workflowAuditSites(audit!, handoff) ?? {})).toEqual([true, true]);
  expect(workflowAuditSites(understand!, handoff)).toBeNull();
  expect(workflowAuditSites(panel!, handoff)).toBeNull();
});

test("prepared workflows are copied into each subject's sandbox project", async () => {
  const [task] = await loadWorkflowAuditTasks(["test1"]);
  for (const subject of ["flywheel", "claude-code"] as const) {
    const directory = temporary("audit-project-");
    await prepareWorkflowAuditProject(task!, directory, subject);
    const path = subject === "flywheel" ? "review.workflow.yaml" : "review.workflow.js";
    expect(await readFile(join(directory, path), "utf8")).toBe(await readFile(subject === "flywheel" ? TEST1_WORKFLOW.flywheel : TEST1_WORKFLOW.claudeCode, "utf8"));
  }
});

test("audit grades count named shipped sites from the handoff summary, not other handoff fields", () => {
  const [parser, completions] = SHIPPED_SITES;
  const key = (site: typeof parser) => `${site!.path}:${site!.lines[0]}-${site!.lines[1]}`;
  expect(workflowAuditGrade({ summary: "json-parse.ts:162 is wrong", detail: "openai-completions.ts:150" })).toEqual({ [key(parser)]: true, [key(completions)]: false });
  // A finding in a result field beside a short summary is part of the answer.
  expect(workflowAuditGrade({ summary: "Two bugs.", kept_bugs: [{ site: "json-parse.ts:162" }, { site: "openai-completions.ts:144" }] })).toEqual({ [key(parser)]: true, [key(completions)]: true });
  expect(Object.values(workflowAuditGrade(undefined))).toEqual([false, false]);
});

test("the judged answer is the summary followed by each filled result field", () => {
  expect(workflowAuditAnswer({ summary: "Kept one bug.", kept: [{ site: "a.ts:1" }], rejected: [], note: "" })).toBe(`Kept one bug.\n\nkept:\n${JSON.stringify([{ site: "a.ts:1" }], null, 2)}`);
  expect(workflowAuditAnswer({ summary: "Only a summary." })).toBe("Only a summary.");
  expect(workflowAuditAnswer(undefined)).toBeNull();
});
