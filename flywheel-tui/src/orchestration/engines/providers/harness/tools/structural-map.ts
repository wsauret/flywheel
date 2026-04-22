import * as fs from "node:fs/promises";
import { extname, basename, relative } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";

interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "method" | "const" | "variable";
  startLine: number;
  endLine: number;
  children?: SymbolInfo[];
}

interface FileMap {
  symbols: SymbolInfo[];
  totalLines: number;
  language: string;
}

type SymbolLookupResult =
  | { type: "found"; symbol: SymbolInfo }
  | { type: "ambiguous"; candidates: SymbolInfo[] }
  | { type: "not-found"; available: SymbolInfo[] };

const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const TSX_EXTENSIONS = new Set([".tsx", ".jsx"]);
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

const CACHE_MAX_SIZE = 100;
const cache = new Map<string, { mtime: number; map: FileMap }>();

function detectLang(filePath: string): Lang | null {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) return Lang.TypeScript;
  if (TSX_EXTENSIONS.has(ext)) return Lang.Tsx;
  if (JS_EXTENSIONS.has(ext)) return Lang.JavaScript;
  return null;
}

function langLabel(lang: Lang): string {
  switch (lang) {
    case Lang.TypeScript: return "TypeScript";
    case Lang.Tsx: return "TSX";
    case Lang.JavaScript: return "JavaScript";
    default: return "unknown";
  }
}

function extractName(node: SgNode): string | null {
  for (const child of node.children()) {
    const kind = child.kind();
    if (kind === "identifier" || kind === "type_identifier" || kind === "property_identifier") return child.text();
  }
  return null;
}

function extractConstName(node: SgNode): string | null {
  for (const child of node.children()) {
    if (child.kind() === "variable_declarator") {
      return extractName(child);
    }
  }
  return null;
}

function lineRange(node: SgNode): { startLine: number; endLine: number } {
  const range = node.range();
  return { startLine: range.start.line + 1, endLine: range.end.line + 1 };
}

function extractMethods(classNode: SgNode): SymbolInfo[] {
  const methods: SymbolInfo[] = [];
  for (const child of classNode.children()) {
    if (child.kind() === "class_body") {
      for (const member of child.children()) {
        const memberKind = member.kind();
        if (memberKind === "method_definition" || memberKind === "public_field_definition") {
          const name = extractName(member);
          if (name) {
            const range = lineRange(member);
            methods.push({ name, kind: "method", ...range });
          }
        }
      }
    }
  }
  return methods;
}

function processNode(node: SgNode): SymbolInfo | null {
  const kind = node.kind();

  switch (kind) {
    case "function_declaration":
    case "function_signature": {
      const name = extractName(node);
      if (!name) return null;
      return { name, kind: "function", ...lineRange(node) };
    }
    case "class_declaration": {
      const name = extractName(node);
      if (!name) return null;
      const children = extractMethods(node);
      const info: SymbolInfo = { name, kind: "class", ...lineRange(node) };
      if (children.length > 0) info.children = children;
      return info;
    }
    case "interface_declaration": {
      const name = extractName(node);
      if (!name) return null;
      return { name, kind: "interface", ...lineRange(node) };
    }
    case "type_alias_declaration": {
      const name = extractName(node);
      if (!name) return null;
      return { name, kind: "type", ...lineRange(node) };
    }
    case "enum_declaration": {
      const name = extractName(node);
      if (!name) return null;
      return { name, kind: "enum", ...lineRange(node) };
    }
    case "lexical_declaration": {
      const name = extractConstName(node);
      if (!name) return null;
      const text = node.text();
      const isConst = text.trimStart().startsWith("const");
      return { name, kind: isConst ? "const" : "variable", ...lineRange(node) };
    }
    case "export_statement": {
      for (const child of node.children()) {
        const result = processNode(child);
        if (result) {
          const range = lineRange(node);
          result.startLine = range.startLine;
          result.endLine = range.endLine;
          return result;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export async function generateFileMap(filePath: string): Promise<FileMap | null> {
  const lang = detectLang(filePath);
  if (!lang) return null;

  const stat = await fs.stat(filePath);
  const mtime = stat.mtimeMs;
  const cached = cache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.map;

  const content = await fs.readFile(filePath, "utf-8");
  const root = parse(lang, content).root();
  const symbols: SymbolInfo[] = [];

  for (const child of root.children()) {
    const info = processNode(child);
    if (info) symbols.push(info);
  }

  symbols.sort((a, b) => a.startLine - b.startLine);
  const totalLines = content.split("\n").length;
  const map: FileMap = { symbols, totalLines, language: langLabel(lang) };

  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(filePath, { mtime, map });

  return map;
}

export function formatFileMap(map: FileMap, filePath: string): string {
  const display = basename(filePath);
  const lines: string[] = [`--- Structural Map (${display}, ${map.totalLines} lines) ---`];
  for (const sym of map.symbols) {
    lines.push(`${sym.kind} ${sym.name}: [${sym.startLine}-${sym.endLine}]`);
    if (sym.children) {
      for (const child of sym.children) {
        lines.push(`  ${child.kind} ${child.name}: [${child.startLine}-${child.endLine}]`);
      }
    }
  }
  return lines.join("\n");
}

function flattenSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
  const flat: SymbolInfo[] = [];
  for (const sym of symbols) {
    flat.push(sym);
    if (sym.children) flat.push(...sym.children);
  }
  return flat;
}

export function lookupSymbol(map: FileMap, query: string): SymbolLookupResult {
  const all = flattenSymbols(map.symbols);
  const available = map.symbols.slice(0, 20);

  if (query.includes(".")) {
    const [parentName, childName] = query.split(".", 2) as [string, string];
    const parent = map.symbols.find((s) => s.name === parentName);
    if (parent?.children) {
      const child = parent.children.find((c) => c.name === childName);
      if (child) return { type: "found", symbol: child };
    }
  }

  const exact = all.find((s) => s.name === query);
  if (exact) return { type: "found", symbol: exact };

  const lowerQuery = query.toLowerCase();
  const caseInsensitive = all.filter((s) => s.name.toLowerCase() === lowerQuery);
  if (caseInsensitive.length === 1) return { type: "found", symbol: caseInsensitive[0]! };
  if (caseInsensitive.length > 1) return { type: "ambiguous", candidates: caseInsensitive };

  const prefixMatches = all.filter((s) => s.name.startsWith(query));
  if (prefixMatches.length === 1) return { type: "found", symbol: prefixMatches[0]! };
  if (prefixMatches.length > 1) return { type: "ambiguous", candidates: prefixMatches };

  const substringMatches = all.filter((s) => s.name.includes(query));
  if (substringMatches.length === 1) return { type: "found", symbol: substringMatches[0]! };
  if (substringMatches.length > 1) return { type: "ambiguous", candidates: substringMatches };

  return { type: "not-found", available };
}
