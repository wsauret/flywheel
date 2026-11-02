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

/** A pinned commit of the benchmarked project, restricted to the listed paths. */
export interface CommitSnapshot {
  readonly commit: string;
  readonly paths: readonly string[];
}

interface CommitSnapshotSpec extends CommitSnapshot {
  patch?: string;
  setup?: readonly (readonly string[])[];
}

export type ImplementSandboxSpec = { fixtureRepo: string } | CommitSnapshotSpec;

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

function parseCommitSnapshot(object: ImplementTaskObject, context: string): CommitSnapshotSpec {
  const commit = immutableGitObjectSelector(object.commit, `${context}.commit`);
  const paths = object.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => typeof path === "string")) {
    throw new Error(`${context}.paths must be a non-empty string array`);
  }
  const setup = object.setup;
  if (setup !== undefined && (!Array.isArray(setup) || !setup.every((cmd) => Array.isArray(cmd) && cmd.length > 0 && cmd.every((word) => typeof word === "string")))) {
    throw new Error(`${context}.setup must be an array of non-empty string arrays`);
  }
  return {
    commit,
    paths,
    ...(object.patch !== undefined ? { patch: relativeTaskPath(object.patch, `${context}.patch`) } : {}),
    ...(setup ? { setup } : {}),
  };
}

export function parseImplementSandbox(value: unknown, context: string): ImplementSandboxSpec {
  const object = objectValue(value, context);
  if (object.commit !== undefined) return parseCommitSnapshot(object, context);
  return { fixtureRepo: relativeTaskPath(object.fixtureRepo, `${context}.fixtureRepo`) };
}
