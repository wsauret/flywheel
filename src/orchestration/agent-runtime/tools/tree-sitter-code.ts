import { extname } from "node:path";
import type { Node, Tree } from "web-tree-sitter";

import { loadTreeSitterParser, type TreeSitterLanguage } from "../../../infra/tree-sitter-parser.js";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);
const TSX_EXTENSIONS = new Set([".tsx", ".jsx"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

export interface TreeSitterSource {
  path: string;
  text: string;
}

/** Return the parser language supported for this path, or null when structural reads are unavailable. */
export function detectTreeSitterLanguage(path: string): TreeSitterLanguage | null {
  const extension = extname(path).toLowerCase();
  if (TYPESCRIPT_EXTENSIONS.has(extension)) return "typescript";
  if (TSX_EXTENSIONS.has(extension)) return extension === ".tsx" ? "tsx" : "javascript";
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return "javascript";
  if (extension === ".py" || extension === ".pyi") return "python";
  return null;
}

export async function withTreeSitterTree<T>(
  source: TreeSitterSource,
  useTree: (root: Node, language: TreeSitterLanguage) => T,
): Promise<T | null> {
  const language = detectTreeSitterLanguage(source.path);
  if (!language) return null;

  let tree: Tree | null = null;
  try {
    const parser = await loadTreeSitterParser(language);
    tree = parser.parse(source.text);
    if (!tree || tree.rootNode.hasError) return null;
    return useTree(tree.rootNode, language);
  } catch {
    return null;
  } finally {
    tree?.delete();
  }
}
