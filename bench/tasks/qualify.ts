import { Schema } from "effect";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ownedCommandRunner } from "../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../src/infra/process-supervisor.js";
import { bytesIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { loadImplementTasks, provisionTaskSandbox, type ImplementTaskSpec } from "../../src/orchestration/modules/development/benchmark/implement-task.js";
import { containedPath, realFileUnder } from "../../src/orchestration/modules/development/benchmark/paths.js";
import { runSandboxCommand } from "../../src/orchestration/modules/development/benchmark/sandbox-command.js";
import { parseJUnitReport } from "../chat-ab/acceptance.js";

const ControlSchema = Schema.Struct({
  id: Schema.String,
  patches: Schema.Array(Schema.String),
  expectation: Schema.Literals(["pass", "fail"]),
  rationale: Schema.String,
  expectedFailures: Schema.Array(Schema.String),
});
const QualificationSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  role: Schema.Literals(["development", "reserved-evaluation"]),
  contentIdentity: Schema.String,
  testIds: Schema.Array(Schema.String),
  cases: Schema.Array(ControlSchema),
});
type Control = typeof ControlSchema.Type;
type Qualification = typeof QualificationSchema.Type;
const decodeQualification = Schema.decodeUnknownSync(QualificationSchema, { onExcessProperty: "error" });

/** Decode controls for this exact task and corpus split. Patches stay outside candidate inputs. */
export function parseQualification(value: unknown, contentIdentity: string): Qualification {
  const metadata = decodeQualification(value);
  if (metadata.contentIdentity !== contentIdentity) throw new Error("qualification content identity differs from the current task");
  const unique = (items: readonly string[], label: string) => {
    if (items.some(item => !item.trim()) || new Set(items).size !== items.length) throw new Error(`${label} must be nonempty and unique`);
  };
  if (!metadata.testIds.length || !metadata.cases.length) throw new Error("qualification requires tests and cases");
  unique(metadata.testIds, "test IDs");
  unique(metadata.cases.map(control => control.id), "case IDs");
  for (const control of metadata.cases) {
    if (!control.rationale.trim() || !control.patches.length) throw new Error(`${control.id} requires rationale and patches`);
    unique(control.patches, `${control.id} patches`);
    for (const patch of control.patches) {
      if (!/^qualification\/[^/\\]+\.patch$/.test(patch) || patch.split("/").some(part => part === "." || part === "..")) {
        throw new Error(`${control.id} patch must name a file directly under qualification/`);
      }
    }
    unique(control.expectedFailures, `${control.id} expected failures`);
    if (control.expectedFailures.some(id => !metadata.testIds.includes(id))) throw new Error(`${control.id} names an unknown failing test`);
    if ((control.expectation === "pass") !== (control.expectedFailures.length === 0)) throw new Error(`${control.id} label disagrees with its expected failures`);
  }
  return metadata;
}

interface Evidence {
  readonly xml: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly outputTruncated: boolean;
}

/** Require all declared tests and only the declared assertion failures. Setup errors never qualify. */
export function checkQualification(control: Control, testIds: readonly string[], evidence: Evidence) {
  const reasons: string[] = [];
  let tests: { id: string; outcome: "pass" | "fail" }[] = [];
  const xml = evidence.xml;
  if (evidence.timedOut) reasons.push("test command timed out");
  if (evidence.outputTruncated) reasons.push("test diagnostics were truncated");
  // Bun omits a file's load error from JUnit when other files still run.
  if (evidence.output.includes("# Unhandled error between tests")) reasons.push("test command reported an unhandled error");
  if (evidence.exitCode !== (control.expectation === "pass" ? 0 : 1)) reasons.push("exit status differs from label");
  if (xml === null) reasons.push("missing JUnit report");
  else {
    try {
      tests = [...parseJUnitReport(xml)].map(([id, outcome]) => ({ id, outcome }));
      const root = xml.match(/<testsuites\b[^>]*\btests="(\d+)"[^>]*>/);
      if (!root || !xml.trimEnd().endsWith("</testsuites>") || Number(root[1]) !== testIds.length) reasons.push("incomplete JUnit report");
      if (/<(?:error|skipped)\b/.test(xml) || /name="\(unnamed\)"/.test(xml)) reasons.push("JUnit contains errors, skipped tests or hook failures");
      const failures = [...xml.matchAll(/<failure\b[^>]*>/g)];
      if (failures.some(([tag]) => !/\btype="AssertionError"/.test(tag))) reasons.push("failure is not a behavioral assertion");
      if (failures.length !== tests.filter(test => test.outcome === "fail").length) reasons.push("JUnit failure count differs from test outcomes");
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  const missingTests = testIds.filter(id => !tests.some(test => test.id === id));
  const unexpectedTests = tests.filter(test => !testIds.includes(test.id)).map(test => test.id);
  const actualFailures = tests.filter(test => test.outcome === "fail").map(test => test.id);
  if (missingTests.length || unexpectedTests.length) reasons.push("test IDs differ from declaration");
  if (actualFailures.length !== control.expectedFailures.length || actualFailures.some(id => !control.expectedFailures.includes(id))) reasons.push("behavioral failures differ from label");
  return { qualified: reasons.length === 0, reasons, tests, actualFailures, missingTests, unexpectedTests };
}

async function qualify(task: Extract<ImplementTaskSpec, { kind?: "plan" }>, metadata: Qualification) {
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, options);
      return {
        ...owned,
        stdout: owned.stdout?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { process.stdout.write(chunk); controller.enqueue(chunk); },
        })),
        stderr: owned.stderr?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { process.stderr.write(chunk); controller.enqueue(chunk); },
        })),
      };
    },
  });
  const results = [];
  try {
    for (const control of metadata.cases) {
      let sandbox: string | undefined;
      const patches = [];
      try {
        for (const path of control.patches) {
          const file = await realFileUnder(task.taskDir, containedPath(task.taskDir, path), `${control.id} patch`);
          const text = await Bun.file(file).text();
          patches.push({ path, identity: bytesIdentity(text), text });
        }
        sandbox = await provisionTaskSandbox(resolve(import.meta.dir, "../.."), task, run);
        const options = { cwd: sandbox, sandboxDir: sandbox };
        for (const patch of patches) {
          const applied = await runSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", "-"], { ...options, stdin: patch.text });
          if (applied.exitCode !== 0 || applied.timedOut) throw new Error(`patch application failed: ${patch.path}`);
        }
        await cp(task.acceptanceDir, join(sandbox, "acceptance"), { recursive: true });
        const result = await runSandboxCommand(run, [process.execPath, "test", "--reporter=junit", "--reporter-outfile=qualification-junit.xml"], options);
        const file = Bun.file(join(sandbox, "qualification-junit.xml"));
        const xml = await file.exists() ? await file.text() : null;
        results.push({
          id: control.id, expectation: control.expectation, expectedFailures: control.expectedFailures,
          patches: patches.map(({ path, identity }) => ({ path, identity })),
          exitCode: result.exitCode, timedOut: result.timedOut,
          ...checkQualification(control, metadata.testIds, {
            xml, exitCode: result.exitCode, timedOut: result.timedOut,
            output: `${result.stdout}\n${result.stderr}`,
            outputTruncated: result.stdoutTruncated === true || result.stderrTruncated === true,
          }),
        });
      } catch (error) {
        results.push({ id: control.id, expectation: control.expectation, expectedFailures: control.expectedFailures,
          patches: patches.map(({ path, identity }) => ({ path, identity })),
          qualified: false, reasons: [`setup failed: ${error instanceof Error ? error.message : String(error)}`], tests: [] });
      } finally {
        if (sandbox) await rm(sandbox, { recursive: true, force: true });
      }
    }
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`qualification scope did not settle: ${closure.reason}`);
    } finally {
      await supervisor.dispose();
    }
  }
  return {
    schemaVersion: 1, role: metadata.role, task: task.id, contentIdentity: task.contentIdentity,
    qualificationIdentity: structuredIdentity(metadata),
    environment: { runtime: "bun", version: Bun.version, platform: process.platform, arch: process.arch },
    qualified: results.every(result => result.qualified), cases: results,
  };
}

async function main(argv: readonly string[]) {
  let taskId: string | undefined;
  let output: string | undefined;
  let tasksDir: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if ((flag !== "--task" && flag !== "--output" && flag !== "--tasks-dir") || !value || value.startsWith("--")) throw new Error(`unknown or incomplete argument: ${flag}`);
    if (flag === "--task" && taskId === undefined) taskId = value;
    else if (flag === "--output" && output === undefined) output = value;
    else if (flag === "--tasks-dir" && tasksDir === undefined) tasksDir = resolve(value);
    else throw new Error(`duplicate argument: ${flag}`);
  }
  if (!taskId || !output) throw new Error("usage: bun run bench/tasks/qualify.ts --task <id> --output <path> [--tasks-dir <dir>]");
  const tasks = await loadImplementTasks(tasksDir ?? join(import.meta.dir, "implement"));
  const task = tasks.find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.kind === "native") throw new Error(`Native task ${task.id} requires its original grader, not Bun qualification`);
  const path = await realFileUnder(task.taskDir, join(task.taskDir, "qualification.json"), "qualification metadata");
  const metadata = parseQualification(JSON.parse(await Bun.file(path).text()), task.contentIdentity);
  const report = await qualify(task, metadata);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Qualification ${report.qualified ? "passed" : "failed"}: ${task.id}; report: ${resolve(output)}`);
  process.exitCode = report.qualified ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
