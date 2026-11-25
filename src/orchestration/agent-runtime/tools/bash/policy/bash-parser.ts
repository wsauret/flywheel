import type { Node, Parser } from "web-tree-sitter";
import { errorDetail, errorMessage } from "../../../../../infra/diagnostics/error-message.js";
import { Log } from "../../../../../infra/diagnostics/log.js";
import { loadTreeSitterParser } from "../../../../../infra/parsing/tree-sitter-parser.js";

export async function loadBashParser(): Promise<Parser> {
  return loadTreeSitterParser("bash");
}

/** Bash policy awaits the shared parser load at the point of use, so this warm
 *  only takes the load cost off the first command. A failed warm is non-fatal. */
export async function warmBashParser(): Promise<void> {
  try {
    await loadBashParser();
  } catch (err) {
    Log.create({ service: "runtime-composition" }).warn("bash parser warmup failed (non-fatal)", { error: errorMessage(err), errorDetail: errorDetail(err) });
  }
}

export function bashCommandNodes(root: Node): Node[] {
  return root.descendantsOfType("command").filter((node): node is Node => node !== null);
}

const HEREDOC = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/y;

function withoutHeredocBodies(command: string): string {
  const kept: string[] = [];
  const delimiters: Array<{ delimiter: string; stripTabs: boolean }> = [];
  let quote: string | undefined;
  for (const line of command.match(/.*(?:\r\n|\n|$)/g) ?? []) {
    if (!line) continue;
    const pending = delimiters[0];
    if (pending) {
      let candidate = line.replace(/[\r\n]+$/, "");
      if (pending.stripTabs) candidate = candidate.replace(/^\t+/, "");
      if (candidate === pending.delimiter) {
        delimiters.shift();
        kept.push("\n");
      }
      continue;
    }
    kept.push(line);
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
      const char = line.charAt(index);
      if (escaped) { escaped = false; continue; }
      if (quote) {
        if (char === "\\" && quote === '"') escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "#" && (index === 0 || /\s/.test(line.charAt(index - 1)))) break;
      if (char !== "<" || (index > 0 && line[index - 1] === "<")) continue;
      HEREDOC.lastIndex = index;
      const match = HEREDOC.exec(line);
      if (!match || line.lastIndexOf("((", index) > line.lastIndexOf("))", index)) continue;
      const delimiter = match.slice(1).find((part) => part !== undefined);
      if (delimiter) delimiters.push({ delimiter, stripTabs: match[0].startsWith("<<-") });
      index = HEREDOC.lastIndex - 1;
    }
  }
  return kept.join("");
}

/** Whether `command` starts a shell-level background job (`&`), which can escape managed ownership. A lexer, not
 *  the tree-sitter parse, decides, so the check holds also when the parser cannot load or parse. */
// eslint-disable-next-line complexity -- Exact shell grammar classification requires explicit lexical branches.
export function hasShellBackgroundJob(command: string): boolean {
  const source = withoutHeredocBodies(command);
  const contexts: Array<"arithmetic" | "arithmetic_group" | "quoted_arithmetic" | "quoted_shell" | "shell"> = [];
  // A `#` starts a comment only at the start of a word.
  let inWord = false;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const char = source.charAt(index);
    if (escaped) { inWord = true; escaped = false; index++; continue; }
    if (quote) {
      if (char === "\\" && quote === '"') escaped = true;
      else if (quote === '"' && source.startsWith("$((", index)) { inWord = true; contexts.push("quoted_arithmetic"); quote = undefined; index += 3; continue; }
      else if (quote === '"' && source.startsWith("$(", index)) { inWord = false; contexts.push("quoted_shell"); quote = undefined; index += 2; continue; }
      else if (char === quote) quote = undefined;
      else inWord = true;
      index++; continue;
    }
    if (char === "'" || char === '"') { quote = char; index++; continue; }
    if (char === "\\") { escaped = true; index++; continue; }
    if (char === "#" && !inWord && (index === 0 || /\s/.test(source.charAt(index - 1)))) { const newline = source.indexOf("\n", index); index = newline < 0 ? source.length : newline; continue; }
    const context = contexts.at(-1);
    if (context === "arithmetic" || context === "arithmetic_group" || context === "quoted_arithmetic") {
      if (source.startsWith("$((", index)) { inWord = true; contexts.push("arithmetic"); index += 3; continue; }
      if (source.startsWith("$(", index)) { inWord = false; contexts.push("shell"); index += 2; continue; }
      if (char === "(") { inWord = true; contexts.push("arithmetic_group"); index++; continue; }
      if (char === ")") {
        inWord = true;
        if ((context === "arithmetic" || context === "quoted_arithmetic") && source.startsWith("))", index)) { contexts.pop(); if (context === "quoted_arithmetic") quote = '"'; index += 2; }
        else { if (context === "arithmetic_group") contexts.pop(); index++; }
        continue;
      }
      inWord = true; index++; continue;
    }
    if (source.startsWith("$((", index)) { inWord = true; contexts.push("arithmetic"); index += 3; continue; }
    if (source.startsWith("((", index)) { inWord = true; contexts.push("arithmetic"); index += 2; continue; }
    if (source.startsWith("$(", index)) { inWord = false; contexts.push("shell"); index += 2; continue; }
    if (char === "(" || char === ")") { inWord = false; if (char === "(") contexts.push("shell"); else if (contexts.at(-1) === "shell" || contexts.at(-1) === "quoted_shell") { const closed = contexts.pop(); if (closed === "quoted_shell") quote = '"'; } index++; continue; }
    if (char === "&") {
      const previous = index > 0 ? source.charAt(index - 1) : "";
      const following = index + 1 < source.length ? source.charAt(index + 1) : "";
      if (previous === ">" || previous === "<") { inWord = true; index++; continue; }
      inWord = false;
      if (following === ">") { index++; continue; }
      if (following === "&") { index += 2; continue; }
      return true;
    }
    if (char === "|") { inWord = false; index += source[index + 1] === "|" || source[index + 1] === "&" ? 2 : 1; continue; }
    if (char === ";" || char === "\n" || /\s/.test(char) || char === "<" || char === ">") { inWord = false; index++; continue; }
    inWord = true; index++;
  }
  return false;
}
