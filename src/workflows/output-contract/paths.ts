import path from "node:path";

/** One problem with an agent output, located by its dotted JSON path. */
export interface OutputIssue {
  readonly path: string;
  readonly message: string;
  readonly hint?: string;
}

/** Check a declared artifact using native path resolution from `executionCwd`.
 *  Empty values are left to the schema. The stored path is not rewritten. */
export async function probePath(
  executionCwd: string,
  pathExists: (absolutePath: string) => Promise<boolean>,
  located: { readonly path: string; readonly value: string },
): Promise<OutputIssue | undefined> {
  if (located.value.trim() === "") return undefined;
  return await pathExists(path.resolve(executionCwd, located.value))
    ? undefined
    : { path: located.path, message: `referenced artifact does not exist: ${located.value}` };
}
