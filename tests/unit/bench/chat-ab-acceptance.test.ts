import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { baselineDrift, baselineOf, classifyAcceptance, parseJUnitReport, scoreAcceptance, type AcceptanceBaseline } from "../../../bench/chat-ab/acceptance.js";
import { listBenchTasks, loadBenchTasks, provisionSandbox } from "../../../bench/chat-ab/tasks.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { mkdir, writeFile } from "node:fs/promises";
import { ownedCommandResult } from "../../helpers/owned-command-fake.js";

const tempDir = temporaryDirectories();

/** The shape Bun 1.4.0 writes for `bun test --reporter=junit`. */
const REPORT = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<testsuites name="bun test" tests="6" failures="2" skipped="2">`,
  `  <testsuite name="acceptance/a.test.ts" file="acceptance/a.test.ts" tests="6">`,
  `    <testsuite name="outer" file="acceptance/a.test.ts" line="2">`,
  `      <testsuite name="inner" file="acceptance/a.test.ts" line="2">`,
  `        <testcase name="same" classname="inner &gt; outer" time="0" file="acceptance/a.test.ts" line="2" assertions="0" />`,
  `      </testsuite>`,
  `      <testcase name="same" classname="outer" time="0" file="acceptance/a.test.ts" line="2" assertions="0" />`,
  `    </testsuite>`,
  `    <testcase name="the parent&apos;s &quot;reply&quot;" classname="" time="0" file="acceptance/a.test.ts" line="3" assertions="1">`,
  `      <failure type="AssertionError" message="expect(received)&#10;">AssertionError: x &lt; y&#10;</failure>`,
  `    </testcase>`,
  `    <testcase name="skipped" classname="" time="0" file="acceptance/a.test.ts" line="4" assertions="0">`,
  `      <skipped />`,
  `    </testcase>`,
  `    <testcase name="todo" classname="" time="0" file="acceptance/a.test.ts" line="5" assertions="0">`,
  `      <skipped message="TODO" />`,
  `    </testcase>`,
  `    <testcase name="slow" classname="" time="0.05" file="acceptance/a.test.ts" line="6" assertions="0">`,
  `      <failure type="TimeoutError" message="test timed out" />`,
  `    </testcase>`,
  `  </testsuite>`,
  `</testsuites>`,
].join("\n");

const baseline: AcceptanceBaseline = { failToPass: ["f > fix-1", "f > fix-2"], passToPass: ["f > guard-1", "f > guard-2"] };

describe("chat A/B acceptance scoring", () => {
  it("initializes the sandbox repository before applying a task patch and commits after setup", async () => {
    const root = tempDir("nested-task-sandbox-");
    const repo = join(root, "repo");
    const workspace = join(repo, "results", "workspace");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(root, "sandbox.patch"), "fixture patch");
    const calls: { command: readonly string[]; cwd: string | undefined }[] = [];
    const sandbox = await provisionSandbox(repo, {
      id: "nested", taskDir: root,
      sandbox: { commit: "fixture", paths: ["."], patch: "sandbox.patch", setup: [["setup-fixture"]] },
    }, async (command, options) => {
      calls.push({ command, cwd: options?.cwd });
      return ownedCommandResult(command.includes("rev-parse") ? "baseline\n" : "");
    }, workspace);
    try {
      const init = calls.findIndex(({ command }) => command.includes("init"));
      const apply = calls.findIndex(({ command }) => command.includes("apply"));
      const setup = calls.findIndex(({ command }) => command[0] === "setup-fixture");
      const commit = calls.findIndex(({ command }) => command.includes("commit"));
      expect(init).toBeGreaterThanOrEqual(0);
      expect(init).toBeLessThan(apply);
      expect(apply).toBeLessThan(setup);
      expect(setup).toBeLessThan(commit);
      expect(calls[init]?.cwd).toBe(sandbox.dir);
      expect(calls[apply]?.cwd).toBe(sandbox.dir);
    } finally { await sandbox.dispose(); }
  });

  it("reads one outcome per test, keyed by its file and full describe path, and fails a skipped or timed-out test", () => {
    expect(parseJUnitReport(REPORT)).toEqual(new Map([
      ["acceptance/a.test.ts > outer > inner > same", "pass"],
      ["acceptance/a.test.ts > outer > same", "pass"],
      [`acceptance/a.test.ts > the parent's "reply"`, "fail"],
      ["acceptance/a.test.ts > skipped", "fail"],
      ["acceptance/a.test.ts > todo", "fail"],
      ["acceptance/a.test.ts > slow", "fail"],
    ]));
  });

  it("fails every test in the scope of a beforeAll or afterAll hook that throws", () => {
    // Bun 1.4.0 reports a throwing all-hook as an "(unnamed)" test of the hook's
    // scope. It leaves out the tests of a throwing beforeAll, and it still
    // reports the tests of a throwing afterAll as passed.
    const hooks = [
      `<testsuites name="bun test">`,
      `  <testsuite name="acceptance/after.test.ts" file="acceptance/after.test.ts">`,
      `    <testsuite name="outer" file="acceptance/after.test.ts" line="3">`,
      `      <testcase name="c" classname="outer" time="0" file="acceptance/after.test.ts" line="3" assertions="1" />`,
      `    </testsuite>`,
      `    <testcase name="(unnamed)" classname="" time="0" file="acceptance/after.test.ts" assertions="0">`,
      `      <failure type="Error" message="boom">Error: boom&#10;</failure>`,
      `    </testcase>`,
      `  </testsuite>`,
      `  <testsuite name="acceptance/nested.test.ts" file="acceptance/nested.test.ts">`,
      `    <testsuite name="outer" file="acceptance/nested.test.ts" line="2">`,
      `      <testcase name="(unnamed)" classname="outer" time="0" file="acceptance/nested.test.ts" assertions="0">`,
      `        <failure type="Error" message="boom">Error: boom&#10;</failure>`,
      `      </testcase>`,
      `    </testsuite>`,
      `    <testcase name="e" classname="" time="0" file="acceptance/nested.test.ts" line="3" assertions="1" />`,
      `  </testsuite>`,
      `</testsuites>`,
    ].join("\n");
    const outcomes = parseJUnitReport(hooks);
    expect(outcomes).toEqual(new Map([["acceptance/after.test.ts > outer > c", "fail"], ["acceptance/nested.test.ts > e", "pass"]]));
    const hooked: AcceptanceBaseline = { failToPass: ["acceptance/nested.test.ts > e"], passToPass: ["acceptance/after.test.ts > outer > c", "acceptance/nested.test.ts > outer > d"] };
    expect(classifyAcceptance(hooked, outcomes)).toEqual({
      failToPass: { "acceptance/nested.test.ts > e": "pass" },
      passToPass: { "acceptance/after.test.ts > outer > c": "fail", "acceptance/nested.test.ts > outer > d": "fail" },
    });
  });

  it("refuses a report in which two tests share one id", () => {
    const twice = REPORT.replace(`<testcase name="slow"`, `<testcase name="todo"`);
    expect(() => parseJUnitReport(twice)).toThrow("two acceptance tests share the id acceptance/a.test.ts > todo");
  });

  it("scores the fraction of baseline-failing tests fixed and counts each broken guard against it", () => {
    const outcomes = new Map([["f > fix-1", "pass"], ["f > fix-2", "pass"], ["f > guard-1", "fail"], ["f > guard-2", "pass"]] as const);
    const record = classifyAcceptance(baseline, outcomes);
    expect(record).toEqual({ failToPass: { "f > fix-1": "pass", "f > fix-2": "pass" }, passToPass: { "f > guard-1": "fail", "f > guard-2": "pass" } });
    expect(scoreAcceptance(record)).toEqual({ fixed: 2, fixable: 2, brokenGuards: ["f > guard-1"], score: 0.5, resolved: false });
    expect(scoreAcceptance(classifyAcceptance(baseline, new Map([["f > fix-1", "pass"], ["f > fix-2", "pass"], ["f > guard-1", "pass"], ["f > guard-2", "pass"]])))).toMatchObject({ score: 1, resolved: true });
  });

  it("keeps a score below zero when a change breaks more guards than it fixes", () => {
    const outcomes = new Map([["f > fix-1", "fail"], ["f > fix-2", "fail"], ["f > guard-1", "fail"], ["f > guard-2", "fail"]] as const);
    expect(scoreAcceptance(classifyAcceptance(baseline, outcomes))).toMatchObject({ fixed: 0, score: -1, resolved: false });
  });

  it("fails a listed test the report leaves out, and every test of a run that wrote no report", () => {
    // Bun leaves out the tests of a file that no longer loads.
    const record = classifyAcceptance(baseline, new Map([["f > fix-1", "pass"], ["f > guard-1", "pass"]]));
    expect(record).toEqual({ failToPass: { "f > fix-1": "pass", "f > fix-2": "fail" }, passToPass: { "f > guard-1": "pass", "f > guard-2": "fail" } });
    expect(scoreAcceptance(classifyAcceptance(baseline, null))).toEqual({ fixed: 0, fixable: 2, brokenGuards: ["f > guard-1", "f > guard-2"], score: -1, resolved: false });
  });

  it("refuses a report that names a test outside the baseline", () => {
    expect(() => classifyAcceptance(baseline, new Map([["f > fix-1", "pass"], ["f > renamed", "pass"]]))).toThrow("not in the task's acceptance baseline: f > renamed");
  });

  it("derives the baseline from an unfixed run and names every way a later run differs from it", () => {
    const unfixed = new Map([["f > guard-1", "pass"], ["f > fix-1", "fail"], ["f > guard-2", "pass"], ["f > fix-2", "fail"]] as const);
    expect(baselineOf(unfixed)).toEqual(baseline);
    expect(baselineDrift(baseline, unfixed)).toEqual([]);
    expect(baselineDrift(baseline, new Map([["f > fix-1", "pass"], ["f > guard-1", "fail"], ["f > guard-2", "pass"], ["f > new", "fail"]]))).toEqual([
      "f > fix-1 passes, but the baseline lists it as failing",
      "f > fix-2 did not run",
      "f > guard-1 fails, but the baseline lists it as passing",
      "f > new is not in the baseline",
    ]);
    expect(() => baselineOf(new Map([["f > guard-1", "pass"]]))).toThrow("no acceptance test fails before the fix");
  });

  it("validates task completeness and selects matching candidate and judge messages with pinned content", async () => {
    const tasksDir = tempDir("chat-ab-tasks-");
    const writeTask = async (id: string, acceptanceBaseline: unknown) => {
      const sandbox = { commit: "660a22b5f26b3dcb8d62c6a75143000d0aa81c4c", paths: ["src"] };
      await Bun.write(join(tasksDir, id, "task.json"), JSON.stringify({ id, stratum: "bug", sandbox, ...(acceptanceBaseline === undefined ? {} : { acceptanceBaseline }) }));
      await Bun.write(join(tasksDir, id, "message.md"), "Fix it.\n");
      await Bun.write(join(tasksDir, id, "WHY.md"), "Why.\n");
      await Bun.write(join(tasksDir, id, "acceptance", "a.test.ts"), "");
    };
    await writeTask("ready", baseline);
    await writeTask("unscored", undefined);
    await writeTask("twice", { failToPass: ["f > fix-1"], passToPass: ["f > fix-1"] });
    expect(await listBenchTasks(tasksDir)).toEqual({ complete: ["ready", "twice"], incomplete: [{ id: "unscored", missing: ["task.json acceptanceBaseline"] }] });
    const [ready] = await loadBenchTasks(tasksDir, ["ready"]);
    expect(ready?.acceptanceBaseline).toEqual(baseline);
    expect(ready?.message).toBe("Fix it.");
    expect(ready?.judgeContext).toBe("Fix it.");
    await expect(loadBenchTasks(tasksDir, ["ready"], undefined, true)).rejects.toThrow("ready/challenge.md");
    await Bun.write(join(tasksDir, "ready", "challenge.md"), "  Try a smaller fix.\n");
    await Bun.write(join(tasksDir, "ready", "task.json"), JSON.stringify({ id: "ready", stratum: "bug", sandbox: ready!.sandbox, acceptanceBaseline: baseline, challenge: { truth: "hold" } }));
    const [challenged] = await loadBenchTasks(tasksDir, ["ready"], undefined, true);
    expect(challenged?.challenge).toEqual({ text: "Try a smaller fix.", truth: "hold" });
    expect(challenged?.contentIdentity).not.toBe(ready?.contentIdentity);
    expect((await loadBenchTasks(tasksDir, ["ready"]))[0]?.contentIdentity).toBe(ready?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "task.json"), JSON.stringify({ id: "ready", stratum: "bug", sandbox: ready!.sandbox, acceptanceBaseline: baseline, challenge: { truth: "change" } }));
    expect((await loadBenchTasks(tasksDir, ["ready"], undefined, true))[0]?.contentIdentity).not.toBe(challenged?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "challenge.md"), "Try another fix.");
    expect((await loadBenchTasks(tasksDir, ["ready"], undefined, true))[0]?.contentIdentity).not.toBe(challenged?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "challenge.md"), "  ");
    await expect(loadBenchTasks(tasksDir, ["ready"], undefined, true)).rejects.toThrow("challenge.md is empty");
    await Bun.write(join(tasksDir, "ready", "challenge.md"), "Try a smaller fix.");
    await Bun.write(join(tasksDir, "ready", "task.json"), JSON.stringify({ id: "ready", stratum: "bug", sandbox: ready!.sandbox, acceptanceBaseline: baseline, challenge: { truth: "unknown" } }));
    await expect(loadBenchTasks(tasksDir, ["ready"], undefined, true)).rejects.toThrow("challenge.truth must be hold or change");
    await Bun.write(join(tasksDir, "ready", "task.json"), JSON.stringify({ id: "ready", stratum: "bug", sandbox: ready!.sandbox, acceptanceBaseline: baseline }));
    await expect(loadBenchTasks(tasksDir, ["ready"], undefined, true)).rejects.toThrow("challenge");
    await expect(loadBenchTasks(tasksDir, ["ready"], "design")).rejects.toThrow("Task ready is incomplete: design.md");
    await Bun.write(join(tasksDir, "ready", "design.md"), "Implement the supplied design.\n");
    const [designed] = await loadBenchTasks(tasksDir, ["ready"], "design");
    expect(designed?.message).toBe("Implement the supplied design.");
    expect(designed?.judgeContext).toBe(designed?.message);
    expect(designed?.contentIdentity).not.toBe(ready?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "message.md"), "Changed original request.\n");
    expect((await loadBenchTasks(tasksDir, ["ready"], "design"))[0]?.contentIdentity).toBe(designed?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "design.md"), "Revised design.\n");
    const [revised] = await loadBenchTasks(tasksDir, ["ready"], "design");
    expect(revised?.contentIdentity).not.toBe(designed?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "reference.patch"), "reference version one");
    const [referenced] = await loadBenchTasks(tasksDir, ["ready"], "design");
    expect(referenced?.contentIdentity).not.toBe(revised?.contentIdentity);
    await Bun.write(join(tasksDir, "ready", "reference.patch"), "reference version two");
    expect((await loadBenchTasks(tasksDir, ["ready"], "design"))[0]?.contentIdentity).not.toBe(referenced?.contentIdentity);
    await expect(loadBenchTasks(tasksDir, ["twice"])).rejects.toThrow("twice/task.json.acceptanceBaseline lists f > fix-1 twice");
  });
});
