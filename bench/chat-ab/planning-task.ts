// The planning tasks of the shared campaign runner. A planning task is one
// folder of bench/tasks/planning (PLANNING_TASKS_DIR):
//   brief.md       the user's request, sent unchanged
//   task.json      { id, stratum, timeoutMinutes, sandbox }, where sandbox is
//                  the shared sandbox spec of task-schema.ts: a commit with its
//                  paths, a task folder named by fixtureRepo, or the empty
//                  tree with no paths, plus optional patch and setup
//   manifest.json  optional { mustAddress, falsePremises? }: the known
//                  requirements that recall scoring and the pairwise judge read
//   WHY.md         why the task exists, with path:line evidence at the pinned tree
// No cell reads the folder: the manifest is the answer key.
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Schema } from "effect";
import type { OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { bytesIdentity, directoryIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { objectValue, parseImplementSandbox, parseManifestPoints, type ImplementSandboxSpec, type ManifestPoint } from "../../src/orchestration/modules/development/benchmark/task-schema.js";
import { REPO_ROOT } from "./harness-paths.js";
import { taskPath } from "./tasks.js";

export const PLANNING_TASKS_DIR = join(REPO_ROOT, "bench", "tasks", "planning");

/** The one instruction that follows every brief. Questions are forbidden because the campaign answer policy approves
 *  only root workflow launches, so a question would end the cell unanswered. */
export const PLANNING_INSTRUCTION = "Write an implementation plan for this request. Do not implement it: change no file except `PLAN.md` at the repository root, which holds the complete plan in Markdown. Treat the request as approved as written. Nobody will answer questions, so record each open question in the plan with the assumption you chose.";

/** Folders a repository task never copies: `bench` holds this answer key, and `inspiration` holds vendored projects. */
const FORBIDDEN_PATHS = ["bench", "inspiration"] as const;

export interface PlanningManifest {
  readonly mustAddress: readonly ManifestPoint[];
  /** The ids of the points that refute a false claim of the brief. */
  readonly falsePremises: readonly string[];
}

export interface PlanningTask {
  readonly id: string;
  readonly stratum: string;
  readonly taskDir: string;
  readonly brief: string;
  /** The brief, then PLANNING_INSTRUCTION. */
  readonly message: string;
  readonly timeoutMs: number;
  readonly sandbox: ImplementSandboxSpec;
  /** Null for a task with no requirements to discover, such as a greenfield task. */
  readonly manifest: PlanningManifest | null;
  readonly contentIdentity: string;
}

const TaskSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  stratum: Schema.NonEmptyString,
  timeoutMinutes: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  sandbox: Schema.Unknown,
});

function parseManifest(value: unknown, context: string): PlanningManifest {
  const object = objectValue(value, context);
  const unknown = Object.keys(object).filter((key) => key !== "mustAddress" && key !== "falsePremises");
  if (unknown.length > 0) throw new Error(`${context} has unknown keys: ${unknown.join(", ")}`);
  const mustAddress = parseManifestPoints(object.mustAddress, `${context}.mustAddress`);
  const falsePremises = object.falsePremises ?? [];
  const ids = new Set(mustAddress.map(({ id }) => id));
  if (!Array.isArray(falsePremises) || falsePremises.some((id) => typeof id !== "string" || !ids.has(id)) || new Set(falsePremises).size !== falsePremises.length) {
    throw new Error(`${context}.falsePremises must list distinct mustAddress ids`);
  }
  return { mustAddress, falsePremises };
}

async function loadPlanningTask(tasksDir: string, id: string): Promise<PlanningTask> {
  const taskDir = join(tasksDir, id);
  if (!existsSync(join(taskDir, "task.json"))) throw new Error(`Unknown planning task: ${id}`);
  const config = Schema.decodeUnknownSync(TaskSchema, { onExcessProperty: "error" })(JSON.parse(await readFile(join(taskDir, "task.json"), "utf8")));
  if (config.id !== id) throw new Error(`${id}/task.json.id must equal its directory name`);
  const sandbox = parseImplementSandbox(config.sandbox, `${id}/task.json.sandbox`);
  const forbidden = "paths" in sandbox ? sandbox.paths.filter((path) => FORBIDDEN_PATHS.some((root) => path === root || path.startsWith(`${root}/`))) : [];
  if (forbidden.length > 0) throw new Error(`${id}/task.json.sandbox.paths must not copy ${forbidden.join(", ")}`);
  const fixture = "fixtureRepo" in sandbox ? await directoryIdentity(taskPath(taskDir, sandbox.fixtureRepo, `${id}/fixtureRepo`)) : undefined;
  const patch = sandbox.patch ? bytesIdentity(new Uint8Array(await Bun.file(taskPath(taskDir, sandbox.patch, `${id}/patch`)).arrayBuffer())) : undefined;
  const brief = (await readFile(join(taskDir, "brief.md"), "utf8")).trim();
  if (!brief) throw new Error(`${id}/brief.md is empty`);
  const manifestPath = join(taskDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? parseManifest(JSON.parse(await readFile(manifestPath, "utf8")), `${id}/manifest.json`) : null;
  const timeoutMs = Math.round(config.timeoutMinutes * 60_000);
  return {
    id, stratum: config.stratum, taskDir, brief, message: `${brief}\n\n${PLANNING_INSTRUCTION}`, timeoutMs,
    sandbox, manifest,
    contentIdentity: structuredIdentity({ id, stratum: config.stratum, timeoutMs, sandbox, ...(fixture ? { fixture } : {}), ...(patch ? { patch } : {}), brief, instruction: PLANNING_INSTRUCTION, manifest }),
  };
}

/** Loads the named tasks in order. Refuses an unknown task or one that breaks the folder contract. */
export async function loadPlanningTasks(tasksDir: string, ids: readonly string[]): Promise<PlanningTask[]> {
  return await Promise.all(ids.map((id) => loadPlanningTask(tasksDir, id)));
}

/** The known requirements as the judges read them. A task with no manifest reads as an empty repository. */
export function renderRequirements(manifest: PlanningManifest | null): string {
  if (manifest === null) return "None: the repository is empty";
  return manifest.mustAddress.map(({ id, title, catchCriteria }) => `- ${id}: ${title}. ${catchCriteria}`).join("\n");
}

const REPOSITORY_PATH = /^[\w.-]+\/[\w./-]+\.\w+$/;

/** Refuses a task whose manifest cites a path that the sandbox source does not hold, so no judge grades a plan against
 *  a requirement the Chat could not see. Runs one `git cat-file -e` for each backticked path of a commit source, and
 *  reads a fixture folder directly. The check reads the source before the task patch. */
export async function qualifyPlanningTask(task: PlanningTask, run: OwnedCommandRunner): Promise<void> {
  const { sandbox } = task;
  const missing: string[] = [];
  for (const point of task.manifest?.mustAddress ?? []) {
    for (const [, path] of point.catchCriteria.matchAll(/`([^`]+)`/g)) {
      if (!REPOSITORY_PATH.test(path!)) continue;
      let held: boolean;
      if ("commit" in sandbox) {
        const object = sandbox.commit.includes(":") ? `${sandbox.commit}/${path}` : `${sandbox.commit}:${path}`;
        held = (await run(["git", "-C", REPO_ROOT, "cat-file", "-e", object], { cwd: REPO_ROOT, timeoutMs: 60_000 })).exitCode === 0;
      } else held = existsSync(join(taskPath(task.taskDir, sandbox.fixtureRepo, `${task.id}/fixtureRepo`), path!));
      if (!held) missing.push(`${point.id}: ${path}`);
    }
  }
  const source = "commit" in sandbox ? sandbox.commit : sandbox.fixtureRepo;
  if (missing.length > 0) throw new Error(`${task.id} cites paths that ${source} does not hold:\n${missing.join("\n")}`);
}
