import type { Node } from "web-tree-sitter";
import type { ShellWriteCommand } from "./bash-write-effects.js";

export interface ParsedCommand extends ShellWriteCommand {
  readonly hasHeredocRedirect: boolean;
}

/** Literal quote removal for command classification, not expansion. */
function unquoteShellPart(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  return (first === '"' || first === "'") && first === text.at(-1) ? text.slice(1, -1) : text;
}

/** Output destinations of a redirect. Descriptor duplication names no file. */
export function outputRedirectTarget(node: Node): string | null | undefined {
  if (!/^\d*(?:>|&>)/.test(node.text.trim()) || /^\d*>{1,2}&\d+$/.test(node.text.trim())) return undefined;
  const destination = node.childForFieldName("destination");
  if (!destination) return null;
  let end = destination.endIndex;
  for (const part of node.namedChildren) {
    if (part?.startIndex === end) end = part.endIndex;
  }
  return node.text.slice(destination.startIndex - node.startIndex, end - node.startIndex);
}

function redirectedCommand(statement: Node): Node | null {
  let body = statement.childForFieldName("body");
  while (body?.type === "list" || body?.type === "pipeline") {
    body = body.namedChildren.toReversed().find(child => child !== null && ["command", "list", "pipeline"].includes(child.type)) ?? null;
  }
  return body?.type === "command" ? body : null;
}

/** Decode one command's raw argv and attached redirects. Adjacent AST words
 * remain one shell word, including PowerShell `$HOME\\file` spellings. */
export function extractShellCommand(node: Node): ParsedCommand {
  const raw: string[] = [];
  let end = -1;
  for (const child of node.namedChildren) {
    if (child === null) continue;
    if (["variable_assignment", "file_redirect", "heredoc_redirect", "herestring_redirect"].includes(child.type)) continue;
    if (child.startIndex === end && raw.length > 0) raw[raw.length - 1] += child.text;
    else raw.push(child.text);
    end = child.endIndex;
  }
  let statement: Node | null = node.parent;
  while (statement && !(statement.type === "redirected_statement" && redirectedCommand(statement)?.id === node.id)) statement = statement.parent;
  const heredoc = statement?.descendantsOfType("heredoc_body")[0];
  return {
    name: unquoteShellPart(raw[0] ?? ""),
    args: raw.slice(1).map(unquoteShellPart),
    rawArgs: raw.slice(1),
    heredocBody: heredoc?.text ?? null,
    hasHeredocRedirect: heredoc !== undefined,
  };
}
