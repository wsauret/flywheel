import { fileSubject, formatDisplayPath, numField, singleLine, strField, type ToolInput } from "../detail-helpers.js";
import type { DetailToolDisplay } from "../types.js";

export function readDetail(input: ToolInput, filePath: string | null): string | null {
  const offset = numField(input, "offset");
  const limit = numField(input, "limit");
  if (offset != null || limit != null) {
    const start = (offset ?? 0) + 1;
    const end = limit != null ? start + limit - 1 : undefined;
    const range = end != null ? `:${start}-${end}` : `:${start}+`;
    return singleLine(`${filePath}${range}`);
  }
  return singleLine(filePath);
}

export const readDisplay: DetailToolDisplay = {
  name: "read",
  action: "file_read",
  displayName: "Read",
  verbs: { progressive: "Reading", past: "Read" },
  isOptimistic: true,
  preservesResultContent: true,
  getDetail: (input, executionCwd) => readDetail(input, formatDisplayPath(strField(input, "path"), executionCwd)),
  getSentence: (_input, _cwd, presentation) => ({ name: readDisplay.verbs.past, detail: fileSubject(presentation.detail) }),
};
