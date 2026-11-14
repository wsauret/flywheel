// The answer-key research tasks of one persona. A task is one folder:
//   task.json      { id, sandbox: { commit, paths } }: the pinned corpus the trial reads
//   prompt.md      the question, sent unchanged
//   manifest.json  optional answer key { facts, traps }
//   WHY.md         why the task exists, with path:line evidence at the pin
// No trial reads the folder: its corpus is the pinned snapshot, which never holds `bench`.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { containedPath, isPresent, realDirectoryUnder, realFileUnder } from "./paths.js";
import type { CommitSnapshot } from "./task-schema.js";

const FactSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  claim: Schema.NonEmptyString,
  catch_criteria: Schema.NonEmptyString,
  files: Schema.NonEmptyArray(Schema.NonEmptyString),
});

const TrapSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  wrong_answer: Schema.NonEmptyString,
});

const AnswerKeySchema = Schema.Struct({
  facts: Schema.NonEmptyArray(FactSchema),
  traps: Schema.Array(TrapSchema),
});

const TaskConfigSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  sandbox: Schema.Struct({ commit: Schema.NonEmptyString, paths: Schema.NonEmptyArray(Schema.NonEmptyString) }),
});

/** The known answer to one research question: the facts a complete answer
 *  states, and the plausible wrong answers that a shallow trace reaches. */
export type ResearchAnswerKey = typeof AnswerKeySchema.Type;

/** A research task as its folder defines it, before the catalog adds its identity. */
export interface ResearchTaskSource {
  readonly id: string;
  readonly prompt: string;
  readonly snapshot: CommitSnapshot;
  readonly answerKey?: ResearchAnswerKey;
}

/** Folders a research corpus never copies: `bench` holds the answer keys, and `inspiration` holds vendored projects. */
const FORBIDDEN_PATHS: ReadonlySet<string> = new Set(["bench", "inspiration"]);

const FULL_COMMIT_ID = /^[0-9a-f]{40}$/;

// `git archive` reads each path as a pathspec: a leading `:` starts pathspec magic, and
// `*`, `?`, `[`, and `\` are glob syntax. Either one can match a forbidden folder.
const PATHSPEC_SYNTAX = /^:|[*?[\]\\]/;

/** The snapshot of a research task: the whole pinned commit, restricted to literal
 *  repository-relative paths, none of which is or lies under a forbidden folder.
 *  The commit is peeled with `^{commit}`, so a tree ID, which `git archive` would
 *  also accept, fails the archive instead of exposing a subtree as the root. */
function researchSnapshot(sandbox: { readonly commit: string; readonly paths: readonly string[] }, context: string): CommitSnapshot {
  if (!FULL_COMMIT_ID.test(sandbox.commit)) throw new Error(`${context}.commit must be a full lowercase commit ID`);
  for (const path of sandbox.paths) {
    const segments = path.split("/");
    if (PATHSPEC_SYNTAX.test(path) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`${context}.paths entry ${JSON.stringify(path)} must be a literal, normalized, repository-relative path`);
    }
    if (FORBIDDEN_PATHS.has(segments[0] ?? "")) throw new Error(`${context}.paths must not copy ${path} into the research corpus`);
  }
  return { commit: `${sandbox.commit}^{commit}`, paths: sandbox.paths };
}

const decodeStrict = { onExcessProperty: "error" } as const;

function parseAnswerKey(value: unknown, context: string): ResearchAnswerKey {
  const key = Schema.decodeUnknownSync(AnswerKeySchema, decodeStrict)(value);
  for (const [label, ids] of [["fact", key.facts.map(({ id }) => id)], ["trap", key.traps.map(({ id }) => id)]] as const) {
    if (new Set(ids).size !== ids.length) throw new Error(`${context} ${label} IDs must be unique`);
  }
  return key;
}

/** Load every research task under `tasksDir`, or none when the folder is absent.
 *  Throws when a task folder is malformed, so a broken answer key never scores a run. */
export async function loadResearchTasks(tasksDir: string): Promise<ResearchTaskSource[]> {
  if (!await isPresent(tasksDir)) return [];
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const tasks: ResearchTaskSource[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const taskDir = await realDirectoryUnder(tasksDir, containedPath(tasksDir, entry.name), `${entry.name} research task`);
    const read = async (name: string) => await Bun.file(await realFileUnder(tasksDir, join(taskDir, name), `${entry.name}/${name}`)).text();
    const config = Schema.decodeUnknownSync(TaskConfigSchema, decodeStrict)(JSON.parse(await read("task.json")));
    if (config.id !== entry.name) throw new Error(`${entry.name}/task.json id must equal its folder name`);
    const snapshot = researchSnapshot(config.sandbox, `${entry.name}/task.json sandbox`);
    const answerKey = await isPresent(join(taskDir, "manifest.json")) ? parseAnswerKey(JSON.parse(await read("manifest.json")), `${entry.name}/manifest.json`) : undefined;
    tasks.push({
      id: config.id,
      prompt: (await read("prompt.md")).trim(),
      snapshot,
      ...(answerKey === undefined ? {} : { answerKey }),
    });
  }
  return tasks;
}
