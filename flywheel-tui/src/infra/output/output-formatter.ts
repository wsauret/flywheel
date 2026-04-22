import * as fs from "node:fs";
import * as path from "node:path";
import { createPatch } from "diff";
import { getToolDisplay, singleLine } from "../tool-display-registry.js";
import { canonicalize } from "../canonical-name.js";

export function getToolDetail(
  name: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd(),
): string | null {
  const meta = getToolDisplay(name);
  if (meta?.getDetail) return meta.getDetail(input, cwd);

  const subject = input.subject as string | undefined;
  if (subject) return singleLine(subject);
  const desc = input.description as string | undefined;
  if (desc) return singleLine(desc);
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length > 0) {
      return singleLine(val);
    }
  }
  return null;
}

const CONTEXT_LINES = 3;

function createEditDiff(filePath: string, oldStr: string, newStr: string, cwd: string = process.cwd()): string {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const fileContent = fs.readFileSync(resolved, "utf-8");

    // The file may or may not be modified when we read it (race between
    // tool_use event and actual execution). Check the longer string first:
    // it's more specific and won't false-match as a substring of the other.
    // Adds (newStr longer): newStr won't spuriously match the unmodified file.
    // Removes (oldStr longer): oldStr won't spuriously match the modified file.
    const fileHasOld = oldStr.length >= newStr.length
      ? fileContent.includes(oldStr)
      : !fileContent.includes(newStr) && fileContent.includes(oldStr);
    const fileHasNew = !fileHasOld && fileContent.includes(newStr);

    let oldContent: string;
    let newContent: string;
    if (fileHasOld) {
      oldContent = fileContent;
      newContent = fileContent.replace(oldStr, newStr);
    } else if (fileHasNew) {
      newContent = fileContent;
      oldContent = fileContent.replace(newStr, oldStr);
    } else {
      return createMinimalDiff(filePath, oldStr, newStr);
    }

    return createPatch(filePath, oldContent, newContent, "", "", { context: CONTEXT_LINES });
  } catch {
    return createMinimalDiff(filePath, oldStr, newStr);
  }
}

function createMinimalDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let result = `--- a/${filePath}\n+++ b/${filePath}\n`;
  result += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  for (const line of oldLines) result += `-${line}\n`;
  for (const line of newLines) result += `+${line}\n`;
  return result;
}

function parseHashlineRef(tag: string): number | null {
  const match = tag.match(/(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return n >= 1 ? n : null;
}

function createHashlineEditDiff(
  filePath: string,
  edits: Array<Record<string, unknown>>,
  filetype: string | undefined,
): ToolDiffInfo | undefined {
  try {
    if (edits.length === 1) {
      const first = edits[0]!;
      const op = first.op as string;
      const lines = first.lines as string[] | undefined;

      if (op === "create") {
        if (!lines) return undefined;
        const lineCount = lines.length;
        return lineCount <= MAX_WRITE_DIFF_LINES
          ? { content: lines.join("\n"), filetype }
          : undefined;
      }

      if (op === "replace_all") {
        if (!lines) return undefined;
        const newContent = lines.join("\n");
        const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        try {
          const oldContent = fs.readFileSync(resolved, "utf-8");
          return { diff: createPatch(filePath, oldContent, newContent, "", "", { context: CONTEXT_LINES }), filetype };
        } catch {
          return newContent.split("\n").length <= MAX_WRITE_DIFF_LINES
            ? { content: newContent, filetype }
            : undefined;
        }
      }
    }

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const oldContent = fs.readFileSync(resolved, "utf-8");
    const fileLines = [...oldContent.split("\n")];

    const sorted = edits
      .map((edit, idx) => {
        const op = edit.op as string;
        let sortLine = 0;
        if (op === "insert_before" || op === "insert_after") {
          sortLine = parseHashlineRef(edit.target as string) ?? 0;
        } else if (op === "replace" || op === "delete") {
          sortLine = parseHashlineRef(edit.end as string) ?? 0;
        }
        return { edit, idx, sortLine };
      })
      .sort((a, b) => b.sortLine - a.sortLine || a.idx - b.idx);

    for (const { edit } of sorted) {
      const op = edit.op as string;
      const lines = edit.lines as string[] | undefined;

      switch (op) {
        case "insert_before": {
          const line = parseHashlineRef(edit.target as string);
          if (line && line <= fileLines.length) fileLines.splice(line - 1, 0, ...(lines ?? []));
          break;
        }
        case "insert_after": {
          const line = parseHashlineRef(edit.target as string);
          if (line && line <= fileLines.length) fileLines.splice(line, 0, ...(lines ?? []));
          break;
        }
        case "replace": {
          const start = parseHashlineRef(edit.start as string);
          const end = parseHashlineRef(edit.end as string);
          if (start && end && end <= fileLines.length) {
            fileLines.splice(start - 1, end - start + 1, ...(lines ?? []));
          }
          break;
        }
        case "delete": {
          const start = parseHashlineRef(edit.start as string);
          const end = parseHashlineRef(edit.end as string);
          if (start && end && end <= fileLines.length) {
            fileLines.splice(start - 1, end - start + 1);
          }
          break;
        }
      }
    }

    const newContent = fileLines.join("\n");
    if (newContent === oldContent) return undefined;
    return { diff: createPatch(filePath, oldContent, newContent, "", "", { context: CONTEXT_LINES }), filetype };
  } catch {
    return undefined;
  }
}

const MAX_WRITE_DIFF_LINES = 200;

type ToolDiffInfo = {
  diff?: string;
  content?: string;
  filetype: string | undefined;
};

export function extractToolDiff(
  name: string,
  input: Record<string, unknown>,
): ToolDiffInfo | undefined {
  const fp = (input.file_path as string) ?? "";
  const ft = getFiletype(fp);
  const lower = canonicalize(name);

  if (lower === "edit") {
    const oldStr = input.old_string as string | undefined;
    const newStr = input.new_string as string | undefined;
    if (oldStr != null && newStr != null) {
      return { diff: createEditDiff(fp, oldStr, newStr), filetype: ft };
    }

    const edits = input.edits as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(edits) && edits.length > 0) {
      return createHashlineEditDiff(fp, edits, ft);
    }
  }

  if (lower === "write") {
    const rawContent = input.content as string | undefined;
    if (rawContent) {
      const lineCount = rawContent.split("\n").length;
      if (lineCount <= MAX_WRITE_DIFF_LINES) {
        return { content: rawContent, filetype: ft };
      }
    }
  }

  return undefined;
}

const RE_INPUT_VALIDATION = /^<tool_use_error>InputValidationError:\s*(.+?)<\/tool_use_error>$/s;
const RE_TOOL_USE_ERROR = /^<tool_use_error>(.+?)<\/tool_use_error>$/s;
const RE_NO_SUCH_TOOL = /^Error: No such tool available:\s*(.+)$/;
const RE_SENSITIVE_EDIT = /^Claude requested permissions to edit (.+?) which is a sensitive file/;
const RE_SENSITIVE_WRITE = /^Claude requested permissions to write to (.+?) which is a sensitive file/;
const RE_SENSITIVE_READ = /^Claude requested permissions to read from (.+?) which is a sensitive file/;

export function extractErrorText(content: string | unknown[] | undefined): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (hasTextString(item)) return item.text;
    }
  }
  return undefined;
}

function hasTextString(item: unknown): item is { text: string } {
  return typeof item === "object" && item !== null && "text" in item && typeof (item as { text: string }).text === "string";
}

const DETAIL_MAX_LEN = 60;

function truncateDetail(text: string): string {
  const first = text.split("\n", 1)[0]!;
  if (first.length <= DETAIL_MAX_LEN) return first;
  return first.slice(0, DETAIL_MAX_LEN - 1) + "…";
}

export function launderToolError(rawError: string, toolName?: string): string {
  const label = toolName ?? "Tool";

  let match = rawError.match(RE_INPUT_VALIDATION);
  if (match) return `${label} failed — invalid input: ${truncateDetail(match[1]!)}`;

  match = rawError.match(RE_NO_SUCH_TOOL);
  if (match) return `Tool not available: ${match[1]}`;

  match = rawError.match(RE_SENSITIVE_EDIT);
  if (match) return `Edit rejected — ${match[1]} is a protected file`;

  match = rawError.match(RE_SENSITIVE_WRITE);
  if (match) return `Write rejected — ${match[1]} is a protected file`;

  match = rawError.match(RE_SENSITIVE_READ);
  if (match) return `Read rejected — ${match[1]} is a protected file`;

  match = rawError.match(RE_TOOL_USE_ERROR);
  if (match) return `${label} failed — ${truncateDetail(match[1]!)}`;

  return `${label} failed`;
}

function getFiletype(filePath: string): string | undefined {
  if (!filePath) return undefined;

  const baseName = path.basename(filePath).toLowerCase();
  const specialNames: Record<string, string> = {
    containerfile: "dockerfile",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  const special = specialNames[baseName];
  if (special) return special;

  const ext = baseName.split(".").pop()?.toLowerCase();
  if (!ext || ext === baseName) return undefined;

  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", rb: "ruby",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", css: "css", scss: "scss", html: "html",
    sql: "sql", sh: "bash", bash: "bash", zsh: "zsh",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    java: "java", kt: "kotlin", swift: "swift",
    lua: "lua", vim: "vim", xml: "xml", graphql: "graphql",
    dockerfile: "dockerfile", containerfile: "dockerfile",
    ps1: "powershell", psm1: "powershell", psd1: "powershell",
    proto: "protobuf", nix: "nix", dart: "dart",
    ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang",
    scala: "scala", clj: "clojure", cljs: "clojure", cljc: "clojure",
    gradle: "groovy", ml: "ocaml", mli: "ocaml", tex: "latex",
    vue: "vue", svelte: "svelte",
  };
  return map[ext] ?? ext;
}
