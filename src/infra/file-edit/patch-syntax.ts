export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
export const ENVIRONMENT_ID_MARKER = "*** Environment ID:";
export const HEREDOC_OPENERS: ReadonlySet<string> = new Set(["<<EOF", "<<'EOF'", "<<\"EOF\""]);

export type PatchOperationHeader =
  | { readonly action: "add"; readonly path: string }
  | { readonly action: "delete"; readonly path: string }
  | { readonly action: "update"; readonly path: string };

/** Classifies an operation header after the caller applies its own whitespace policy. */
export function patchOperationHeader(line: string): PatchOperationHeader | undefined {
  if (line.startsWith(ADD_FILE_MARKER)) return { action: "add", path: line.slice(ADD_FILE_MARKER.length) };
  if (line.startsWith(DELETE_FILE_MARKER)) return { action: "delete", path: line.slice(DELETE_FILE_MARKER.length) };
  if (line.startsWith(UPDATE_FILE_MARKER)) return { action: "update", path: line.slice(UPDATE_FILE_MARKER.length) };
  return undefined;
}

export function isPatchHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === END_PATCH_MARKER || patchOperationHeader(trimmed) !== undefined;
}
