/**
 * Structural code search tool using @ast-grep/napi.
 *
 * Parses source files and searches for AST pattern matches,
 * supporting language-specific structural queries with metavariables.
 */

import * as fs from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";
import { truncateToolOutput } from "./tool-utils.js";

const log = Log.create({ service: "harness-ast-search" });

const MAX_MATCHES = 200;

const LANG_MAP: Record<string, Lang> = {
  typescript: Lang.TypeScript,
  ts: Lang.TypeScript,
  tsx: Lang.Tsx,
  javascript: Lang.JavaScript,
  js: Lang.JavaScript,
  jsx: Lang.Tsx,
  html: Lang.Html,
  css: Lang.Css,
};

const LANG_EXTENSIONS: Record<string, string[]> = {
  [Lang.TypeScript]: [".ts", ".mts", ".cts"],
  [Lang.Tsx]: [".tsx", ".jsx"],
  [Lang.JavaScript]: [".js", ".mjs", ".cjs"],
  [Lang.Html]: [".html", ".htm"],
  [Lang.Css]: [".css"],
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const META_VAR_NAMES = ["A", "B", "C", "D", "E", "F", "X", "Y", "Z", "NAME", "ARGS", "BODY", "VALUE", "TYPE", "RET", "FN", "EXPR", "PATTERN"];

function resolveLang(input: string | undefined): Lang | null {
  if (!input) return null;
  return LANG_MAP[input.toLowerCase().trim()] ?? null;
}

function inferLangFromExtension(filePath: string): Lang | null {
  const ext = extname(filePath).toLowerCase();
  for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
    if (exts.includes(ext)) return lang as Lang;
  }
  return null;
}

interface MatchResult {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  metaVariables: Record<string, string>;
}

async function searchFile(filePath: string, patternStr: string, lang: Lang): Promise<MatchResult[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const root = parse(lang, content);
  const rootNode = root.root();
  const matches = rootNode.findAll(patternStr);

  return matches.map((node) => {
    const range = node.range();
    const startLine = range.start.line + 1;
    const endLine = range.end.line + 1;
    const text = node.text();

    const metaVariables: Record<string, string> = {};
    for (const name of META_VAR_NAMES) {
      // Single-node capture: $NAME
      const mv = node.getMatch(`$${name}`);
      if (mv) {
        metaVariables[`$${name}`] = mv.text();
        continue;
      }
      // Variadic capture: $$$NAME (matches zero or more nodes)
      const multi = node.getMultipleMatches(`$$$${name}`);
      if (multi.length > 0) {
        metaVariables[`$$$${name}`] = multi.map((n) => n.text()).join(", ");
      }
    }

    return { file: filePath, startLine, endLine, text, metaVariables };
  });
}

async function walkFiles(dir: string, lang: Lang): Promise<string[]> {
  const extensions = LANG_EXTENSIONS[lang];
  if (!extensions) return [];

  const result: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(currentDir); }
    catch { return; }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const fullPath = join(currentDir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try { stat = await fs.stat(fullPath); }
      catch { continue; }
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (stat.isFile()) {
        const ext = extname(name).toLowerCase();
        if (extensions.includes(ext)) result.push(fullPath);
      }
    }
  }

  await walk(dir);
  return result;
}

function createAstSearchDefinition(): ToolDefinition {
  return {
    name: "ast_search",
    description:
      "Search code using structural AST patterns via ast-grep. Use this when syntax shape matters " +
      "more than raw text — e.g. finding all function declarations, specific import patterns, or " +
      "class shapes. Metavariables: $NAME captures a single node, $$$ARGS captures zero or more " +
      "(variadic). Example: \"function $NAME($$$ARGS) { $$$BODY }\" matches all function declarations " +
      "and captures the name, arguments, and body. " +
      "Use text_search instead when looking for exact strings, identifiers, or regex patterns. " +
      "Defaults to TypeScript for directory searches.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "AST pattern to match (ast-grep pattern syntax)",
        },
        language: {
          type: "string",
          description: 'Language override (e.g. "typescript", "javascript", "python")',
        },
        path: {
          type: "string",
          description: "File or directory to search (default: cwd)",
        },
      },
      required: ["pattern"],
    },
    async execute(input: Record<string, unknown>, context: ToolContext) {
      if (typeof input.pattern !== "string") {
        return { content: "ast_search requires a string 'pattern' parameter", isError: true };
      }

      const patternStr = input.pattern;
      if (!patternStr.trim()) return { content: "Pattern must not be empty", isError: true };

      const searchPath = typeof input.path === "string"
        ? (input.path.startsWith("/") ? input.path : resolve(context.cwd, input.path))
        : context.cwd;

      let lang = resolveLang(typeof input.language === "string" ? input.language : undefined);

      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try { stat = await fs.stat(searchPath); }
      catch { return { content: `Path not found: ${input.path ?? "."}`, isError: true }; }

      const allMatches: MatchResult[] = [];

      try {
        if (stat.isFile()) {
          if (!lang) lang = inferLangFromExtension(searchPath);
          if (!lang) {
            return {
              content: `Cannot determine language for: ${searchPath}. Specify the "language" parameter.`,
              isError: true,
            };
          }
          const matches = await searchFile(searchPath, patternStr, lang);
          allMatches.push(...matches);
        } else if (stat.isDirectory()) {
          if (!lang) lang = Lang.TypeScript;
          const files = await walkFiles(searchPath, lang);
          for (const file of files) {
            if (allMatches.length >= MAX_MATCHES) break;
            try {
              const matches = await searchFile(file, patternStr, lang);
              allMatches.push(...matches);
            } catch {
              continue;
            }
          }
        } else {
          return { content: `Path is not a file or directory: ${input.path ?? "."}`, isError: true };
        }
      } catch (err) {
        const msg = errorMessage(err);
        log.warn("ast_search failed", { pattern: patternStr, error: msg });
        return { content: `AST search error: ${msg}`, isError: true };
      }

      if (allMatches.length === 0) return { content: "No matches found", isError: false };

      const lines: string[] = [];
      const fileGroups = new Map<string, MatchResult[]>();
      for (const match of allMatches.slice(0, MAX_MATCHES)) {
        const rel = relative(context.cwd, match.file);
        const displayPath = rel || match.file;
        if (!fileGroups.has(displayPath)) fileGroups.set(displayPath, []);
        fileGroups.get(displayPath)!.push(match);
      }

      const matchCount = Math.min(allMatches.length, MAX_MATCHES);
      lines.push(`${matchCount} match(es) in ${fileGroups.size} file(s)`);
      lines.push("");

      for (const [filePath, matches] of fileGroups) {
        lines.push(`# ${filePath}`);
        for (const match of matches) {
          const matchLines = match.text.split("\n");
          for (let i = 0; i < matchLines.length; i++) {
            lines.push(`  ${match.startLine + i}: ${matchLines[i]}`);
          }
          const metaEntries = Object.entries(match.metaVariables);
          if (metaEntries.length > 0) {
            const serialized = metaEntries
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => `${k}=${v}`)
              .join(", ");
            lines.push(`  meta: ${serialized}`);
          }
        }
        lines.push("");
      }

      const truncationNote = allMatches.length > MAX_MATCHES ? "... results truncated\n" : "";
      const output = `${lines.join("\n")}${truncationNote}`;
      return { content: truncateToolOutput(output), isError: false };
    },
  };
}

export const astSearchDefinition = createAstSearchDefinition();
