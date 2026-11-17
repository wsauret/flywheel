import { sanitizePresentationText } from "../../control-characters.js";
import { fileSubject, formatDisplayPath, singleLine, strField } from "../detail-helpers.js";
import { getFiletype } from "../filetype.js";
import type { StreamingRowDerivation, ToolDiffInfo, ToolDisplay, ToolPresentation, ToolPresentationResolution, ToolRowPresentation } from "../types.js";

const FILE_HEADER = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/;
const SECTION_HEADER = /^@@ (.+)$/;
/** The characters that end a line for a regular expression. */
const LINE_BREAK = /[\n\r\u2028\u2029]/g;

/** The file headers of a patch, read one line at a time as the patch
 *  arrives: active V4A paths, and retired hashline section paths for
 *  historical replay. Each character is read once, and only a line that can
 *  still be a header is kept while it streams. */
class PatchHeaders {
  private readonly files: string[] = [];
  private readonly sections: string[] = [];
  /** The line being read; undefined once it cannot be a header. */
  private line: string | undefined = "";

  /** Reads appended patch text; returns whether the paths can have changed. */
  append(text: string): boolean {
    const before = { files: this.files.length, sections: this.sections.length };
    LINE_BREAK.lastIndex = 0;
    let from = 0;
    for (let found = LINE_BREAK.exec(text); found !== null; found = LINE_BREAK.exec(text)) {
      if (this.line !== undefined) this.read(this.line + text.slice(from, found.index), this.files, this.sections);
      this.line = "";
      from = LINE_BREAK.lastIndex;
    }
    if (this.line !== undefined) {
      const line = this.line + text.slice(from);
      this.line = line.startsWith("*** ") || "*** ".startsWith(line) || line.startsWith("@@ ") || "@@ ".startsWith(line) ? line : undefined;
    }
    return this.line !== undefined || this.files.length !== before.files || this.sections.length !== before.sections;
  }

  /** The paths the patch names so far, the line being read included. */
  paths(): string[] {
    const files = [...this.files];
    const sections = [...this.sections];
    if (this.line) this.read(this.line, files, sections);
    return files.length > 0 ? files : sections;
  }

  private read(line: string, files: string[], sections: string[]): void {
    const file = FILE_HEADER.exec(line)?.[1];
    if (file !== undefined) files.push(file.trimEnd());
    const section = SECTION_HEADER.exec(line)?.[1];
    if (section !== undefined) sections.push(section.trimEnd());
  }
}

function extractDisplayPaths(input: string | undefined): string[] {
  if (!input) return [];
  const headers = new PatchHeaders();
  headers.append(input);
  return headers.paths();
}

function presentationForPath(path: string, executionCwd: string): ToolPresentationResolution {
  const detail = singleLine(formatDisplayPath(path, executionCwd));
  return detail === null ? "input_not_ready" : { name: "Edit", detail };
}

/** The row of a call that names its file in `path`, or else in the headers
 *  of its `input` patch (`patchPaths`, undefined before the patch starts). */
function presentationFor(path: string | undefined, patchPaths: readonly string[] | undefined, executionCwd: string): ToolPresentationResolution {
  if (path) return presentationForPath(path, executionCwd);
  if (patchPaths === undefined || patchPaths.length === 0) return "input_not_ready";
  if (patchPaths.length > 1) return { name: "Edit", detail: "" };
  const only = patchPaths[0];
  return only === undefined ? "input_not_ready" : presentationForPath(only, executionCwd);
}

function sentenceFor(path: string | undefined, patchPaths: readonly string[] | undefined, presentation: ToolPresentation): ToolPresentation {
  return {
    name: editDisplay.verbs.past,
    detail: [...new Set((path ? [path] : patchPaths ?? []).map(fileSubject))].join(", ") || fileSubject(presentation.detail),
  };
}

/** The row of a streaming edit: a path as it streams, or the file headers of
 *  a patch, taken from each line once. */
function streamingEditRow(executionCwd: string): StreamingRowDerivation {
  let path = "";
  let headers: PatchHeaders | undefined;
  let row: ToolRowPresentation | undefined;
  return {
    advance: (additions) => {
      path += additions.path ?? "";
      const patchChanged = additions.input !== undefined && (headers ??= new PatchHeaders()).append(additions.input);
      if (row !== undefined && additions.path === undefined && !patchChanged) return row;
      const patchPaths = headers?.paths();
      const resolved = presentationFor(path, patchPaths, executionCwd);
      const presentation = resolved === "input_not_ready"
        ? { name: editDisplay.displayName, detail: "" }
        : { name: sanitizePresentationText(resolved.name), detail: sanitizePresentationText(resolved.detail) };
      const sentence = sentenceFor(path, patchPaths, presentation);
      row = { presentation, sentence: { name: sanitizePresentationText(sentence.name), detail: sanitizePresentationText(sentence.detail) } };
      return row;
    },
  };
}

export const editDisplay: ToolDisplay = {
  name: "edit",
  action: "file_edit",
  displayName: "Edit",
  verbs: { progressive: "Editing", past: "Edited" },
  isOptimistic: false,
  getSentence: (input, _cwd, presentation) => sentenceFor(strField(input, "path"), extractDisplayPaths(strField(input, "input")), presentation),
  fileChangeKind: (input) => strField(input, "input") === undefined ? "replace" : "patch",
  streamingInput: {
    bodyFields: { "edits.*.old_string": "content", "edits.*.new_string": "content", old_string: "content", new_string: "content", input: "diff" },
    presentationFields: ["path", "input"],
    row: streamingEditRow,
  },
  getPresentation: (input, executionCwd) => {
    const patch = strField(input, "input");
    return presentationFor(strField(input, "path"), patch === undefined ? undefined : extractDisplayPaths(patch), executionCwd);
  },
  extractDiff: (input): ToolDiffInfo | undefined => {
    const explicitPath = strField(input, "path");
    if (explicitPath) return { filetype: getFiletype(explicitPath) };
    const inputText = strField(input, "input");
    const path = extractDisplayPaths(inputText)[0];
    return path ? { filetype: getFiletype(path) } : undefined;
  },
};
