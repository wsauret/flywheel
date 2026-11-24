import { isAbsolute, win32 } from "node:path";

export interface ManifestPoint {
  id: string;
  title: string;
  catchCriteria: string;
}

export interface ImplementManifest {
  traps: readonly ManifestPoint[];
  judgment: readonly ManifestPoint[];
}

export interface ImplementTaskObject {
  [field: string]: unknown;
}

/** A pinned commit of the benchmarked project, restricted to the listed paths.
 *  The empty tree with no paths is the empty source. */
export interface CommitSnapshot {
  readonly commit: string;
  readonly paths: readonly string[];
}

/** Git's empty tree. Every repository holds it, so archiving it with no path provisions an empty sandbox. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Where a sandbox's files come from: a pinned commit, a directory of the task that holds the files verbatim, or the empty tree. */
type SandboxSource = CommitSnapshot | { readonly fixtureRepo: string };

/** A sandbox source, the task patch applied on top of it, and the sandbox's setup commands. */
export type ImplementSandboxSpec = SandboxSource & {
  readonly patch?: string;
  readonly setup?: readonly (readonly string[])[];
};

export function objectValue(value: unknown, context: string): ImplementTaskObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

export function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string`);
  return value;
}

/** Validates task-declared directories before a candidate workspace exists. */
export function parseNativePath(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array of workspace-relative directories`);
  return value.map((entry, index) => {
    const path = stringValue(entry, `${context}[${index}]`);
    if (isAbsolute(path) || win32.parse(path).root !== "" || path.split(/[\\/]/).includes("..")) {
      throw new Error(`${context}[${index}] must be relative to the workspace with no .. segment`);
    }
    return path;
  });
}

const IMMUTABLE_GIT_OBJECT_SELECTOR = /^[0-9a-f]{4,40}(?::.+)?$/i;

/** Accepts only immutable Git object IDs, with an optional path inside that object. */
export function immutableGitObjectSelector(value: unknown, context: string): string {
  const selector = stringValue(value, context);
  if (selector.includes("\0") || !IMMUTABLE_GIT_OBJECT_SELECTOR.test(selector)) {
    throw new Error(`${context} must be a hexadecimal Git object ID, optionally followed by :subtree`);
  }
  return selector;
}

export function parseManifestPoints(value: unknown, context: string): ManifestPoint[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const points = value.map((point, index) => {
    const object = objectValue(point, `${context}[${index}]`);
    return {
      id: stringValue(object.id, `${context}[${index}].id`),
      title: stringValue(object.title, `${context}[${index}].title`),
      catchCriteria: stringValue(object.catchCriteria, `${context}[${index}].catchCriteria`),
    };
  });
  if (new Set(points.map((point) => point.id)).size !== points.length) throw new Error(`${context} IDs must be unique`);
  return points;
}

function relativeTaskPath(value: unknown, context: string): string {
  const path = stringValue(value, context);
  if (isAbsolute(path)) throw new Error(`${context} must be relative to its task directory`);
  return path;
}

function parseSandboxSource(object: ImplementTaskObject, context: string): SandboxSource {
  if (object.commit === undefined) return { fixtureRepo: relativeTaskPath(object.fixtureRepo, `${context}.fixtureRepo`) };
  const commit = immutableGitObjectSelector(object.commit, `${context}.commit`);
  const paths = object.paths;
  // `git archive` with no path copies the whole tree, so only the empty tree may list none.
  if (!Array.isArray(paths) || (paths.length === 0) !== (commit === EMPTY_TREE) || !paths.every((path) => typeof path === "string")) {
    throw new Error(`${context}.paths must be a non-empty string array, or empty for the empty tree`);
  }
  return { commit, paths };
}

export function parseImplementSandbox(value: unknown, context: string): ImplementSandboxSpec {
  const object = objectValue(value, context);
  // A misspelled key such as `ptach` would otherwise provision the task without its patch.
  const fields = object.commit === undefined ? ["fixtureRepo", "patch", "setup"] : ["commit", "paths", "patch", "setup"];
  const unknown = Object.keys(object).find((key) => !fields.includes(key));
  if (unknown !== undefined) throw new Error(`${context}.${unknown} is not a sandbox field`);
  const setup = object.setup;
  if (setup !== undefined && (!Array.isArray(setup) || !setup.every((cmd) => Array.isArray(cmd) && cmd.length > 0 && cmd.every((word) => typeof word === "string")))) {
    throw new Error(`${context}.setup must be an array of non-empty string arrays`);
  }
  return {
    ...parseSandboxSource(object, context),
    ...(object.patch !== undefined ? { patch: relativeTaskPath(object.patch, `${context}.patch`) } : {}),
    ...(setup ? { setup } : {}),
  };
}
