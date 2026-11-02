import { basename } from "node:path";
import type { Node } from "web-tree-sitter";
import type { TreeSitterLanguage } from "../../../infra/tree-sitter-parser.js";
import { type TreeSitterSource, withTreeSitterTree } from "./tree-sitter-code.js";

interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "enum" | "method" | "const" | "variable";
  startLine: number;
  endLine: number;
  children?: SymbolInfo[];
}

export interface FileMap {
  symbols: SymbolInfo[];
  totalLines: number;
  language: string;
}

type SymbolLookupResult =
  | { type: "found"; symbol: SymbolInfo }
  | { type: "ambiguous"; candidates: SymbolInfo[] }
  | { type: "not-found"; available: SymbolInfo[] };


function childrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}


function langLabel(lang: TreeSitterLanguage): string {
  switch (lang) {
    case "typescript": return "TypeScript";
    case "tsx": return "TSX";
    case "javascript": return "JavaScript";
    case "python": return "Python";
    default: return "unknown";
  }
}

function extractName(node: Node): string | null {
  for (const child of childrenOf(node)) {
    const kind = child.type;
    if (kind === "identifier" || kind === "type_identifier" || kind === "property_identifier") return child.text;
  }
  return null;
}

function extractConstName(node: Node): string | null {
  for (const child of childrenOf(node)) {
    if (child.type === "variable_declarator") {
      return extractName(child);
    }
  }
  return null;
}

function lineRange(node: Node) {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

function extractMethods(classNode: Node): SymbolInfo[] {
  const methods: SymbolInfo[] = [];
  for (const child of childrenOf(classNode)) {
    if (child.type === "block") {
      for (const member of childrenOf(child)) {
        const info = processNode(member);
        if (info?.kind === "function") methods.push({ ...info, kind: "method" });
      }
    }
    if (child.type === "class_body") {
      for (const member of childrenOf(child)) {
        const memberKind = member.type;
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

function processNode(node: Node): SymbolInfo | null {
  const kind = node.type;

  switch (kind) {
    case "function_declaration":
    case "function_definition":
    case "function_signature": {
      const name = extractName(node);
      if (!name) return null;
      return { name, kind: "function", ...lineRange(node) };
    }
    case "class_declaration":
    case "class_definition": {
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
      const text = node.text;
      const isConst = text.trimStart().startsWith("const");
      return { name, kind: isConst ? "const" : "variable", ...lineRange(node) };
    }
    case "expression_statement": {
      const assignment = node.firstNamedChild;
      if (assignment?.type !== "assignment") return null;
      const left = assignment.childForFieldName("left");
      if (left?.type !== "identifier") return null;
      return { name: left.text, kind: "const", ...lineRange(node) };
    }
    case "export_statement":
    case "decorated_definition": {
      for (const child of childrenOf(node)) {
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

export async function generateFileMap(source: TreeSitterSource): Promise<FileMap | null> {
  return withTreeSitterTree(source, (root, language) => {
    const symbols: SymbolInfo[] = [];
    for (const child of childrenOf(root)) {
      const info = processNode(child);
      if (info) symbols.push(info);
    }
    symbols.sort((left, right) => left.startLine - right.startLine);
    return {
      symbols,
      totalLines: source.text.split("\n").length,
      language: langLabel(language),
    };
  });
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

/** Resolve a filtered match set: exactly one is `found`, more than one is
 *  `ambiguous`, none yields null so the caller falls through to the next tier.
 *  Destructuring the sole element avoids indexing past the `length` check. */
function resolveMatches(matches: SymbolInfo[]): SymbolLookupResult | null {
  const [first, ...rest] = matches;
  if (first === undefined) return null;
  if (rest.length === 0) return { type: "found", symbol: first };
  return { type: "ambiguous", candidates: matches };
}

export function lookupSymbol(map: FileMap, query: string): SymbolLookupResult {
  const all = flattenSymbols(map.symbols);
  const available = map.symbols.slice(0, 20);

  const [parentName, childName] = query.split(".", 2);
  if (parentName !== undefined && childName !== undefined) {
    const parent = map.symbols.find((s) => s.name === parentName);
    if (parent?.children) {
      const child = parent.children.find((c) => c.name === childName);
      if (child) return { type: "found", symbol: child };
    }
  }

  const exact = all.find((s) => s.name === query);
  if (exact) return { type: "found", symbol: exact };

  const lowerQuery = query.toLowerCase();
  const caseInsensitive = resolveMatches(all.filter((s) => s.name.toLowerCase() === lowerQuery));
  if (caseInsensitive) return caseInsensitive;

  const prefixMatches = resolveMatches(all.filter((s) => s.name.startsWith(query)));
  if (prefixMatches) return prefixMatches;

  const substringMatches = resolveMatches(all.filter((s) => s.name.includes(query)));
  if (substringMatches) return substringMatches;

  return { type: "not-found", available };
}
