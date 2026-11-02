import type { Node, Parser } from "web-tree-sitter";
import { errorDetail, errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { loadTreeSitterParser } from "../../../infra/tree-sitter-parser.js";

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

export type ShellDetachmentKind = "none" | "ambiguous" | "service_detach";

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

function invokedCommandBasename(words: string[]): string | undefined {
  let index = 0;
  while (index < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test((words[index] ?? ""))) { index++; continue; }
    const command = (words[index] ?? "").split("/").at(-1) ?? "";
    index++;
    if (command === "command") {
      if (words[index] === "-v" || words[index] === "-V") return undefined;
      while (words[index] === "-p" || words[index] === "--") index++;
      continue;
    }
    if (command === "exec") {
      while (index < words.length) {
        if (words[index] === "--") { index++; break; }
        if (words[index] === "-a" && index + 1 < words.length) { index += 2; continue; }
        if (words[index] === "-c" || words[index] === "-l") { index++; continue; }
        break;
      }
      continue;
    }
    if (command === "env") {
      const valued = new Set(["-C", "-S", "-u", "--argv0", "--block-signal", "--chdir", "--default-signal", "--ignore-signal", "--split-string", "--unset"]);
      while (index < words.length) {
        const word = (words[index] ?? "");
        if (word === "--") { index++; break; }
        if (!word.startsWith("-") || word === "-") break;
        index++;
        if (valued.has(word) && index < words.length) index++;
      }
      while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test((words[index] ?? ""))) index++;
      continue;
    }
    return command;
  }
  return undefined;
}

interface ShellCommandAnalysis {
  readonly commands: ReadonlySet<string>;
  readonly hasBackgroundJob: boolean;
}


// eslint-disable-next-line complexity -- Exact shell grammar classification requires explicit lexical branches.
function analyzeShellCommands(command: string): ShellCommandAnalysis {
  const source = withoutHeredocBodies(command);
  const words: Array<[string, boolean]> = [];
  const token: string[] = [];
  const contexts: Array<"arithmetic" | "arithmetic_group" | "quoted_arithmetic" | "quoted_shell" | "shell"> = [];
  let hasBackgroundJob = false;
  let commandPosition = true;
  let quote: string | undefined;
  let escaped = false;
  const finishWord = () => {
    if (token.length === 0) return;
    words.push([token.join(""), commandPosition]);
    token.length = 0;
    commandPosition = false;
  };
  for (let index = 0; index < source.length;) {
    const char = source.charAt(index);
    if (escaped) { token.push(char); escaped = false; index++; continue; }
    if (quote) {
      if (char === "\\" && quote === '"') escaped = true;
      else if (quote === '"' && source.startsWith("$((", index)) { token.push("$(("); contexts.push("quoted_arithmetic"); quote = undefined; index += 3; continue; }
      else if (quote === '"' && source.startsWith("$(", index)) { finishWord(); contexts.push("quoted_shell"); quote = undefined; commandPosition = true; index += 2; continue; }
      else if (char === quote) quote = undefined;
      else token.push(char);
      index++; continue;
    }
    if (char === "'" || char === '"') { quote = char; index++; continue; }
    if (char === "\\") { escaped = true; index++; continue; }
    if (char === "#" && token.length === 0 && (index === 0 || /\s/.test(source.charAt(index - 1)))) { const newline = source.indexOf("\n", index); index = newline < 0 ? source.length : newline; continue; }
    const context = contexts.at(-1);
    if (context === "arithmetic" || context === "arithmetic_group" || context === "quoted_arithmetic") {
      if (source.startsWith("$((", index)) { token.push("$(("); contexts.push("arithmetic"); index += 3; continue; }
      if (source.startsWith("$(", index)) { finishWord(); contexts.push("shell"); commandPosition = true; index += 2; continue; }
      if (char === "(") { token.push(char); contexts.push("arithmetic_group"); index++; continue; }
      if (char === ")") {
        if ((context === "arithmetic" || context === "quoted_arithmetic") && source.startsWith("))", index)) { token.push("))"); contexts.pop(); if (context === "quoted_arithmetic") quote = '"'; index += 2; }
        else { token.push(char); if (context === "arithmetic_group") contexts.pop(); index++; }
        continue;
      }
      token.push(char); index++; continue;
    }
    if (source.startsWith("$((", index)) { token.push("$(("); contexts.push("arithmetic"); index += 3; continue; }
    if (source.startsWith("((", index)) { token.push("(("); contexts.push("arithmetic"); index += 2; continue; }
    if (source.startsWith("$(", index)) { finishWord(); contexts.push("shell"); commandPosition = true; index += 2; continue; }
    if (char === "(" || char === ")") { finishWord(); if (char === "(") contexts.push("shell"); else if (contexts.at(-1) === "shell" || contexts.at(-1) === "quoted_shell") { const closed = contexts.pop(); if (closed === "quoted_shell") quote = '"'; } commandPosition = char === "("; index++; continue; }
    if (char === "&") {
      const previous = index > 0 ? source.charAt(index - 1) : "";
      const following = index + 1 < source.length ? source.charAt(index + 1) : "";
      if (previous === ">" || previous === "<") { token.push(char); index++; continue; }
      if (following === ">") { finishWord(); index++; continue; }
      finishWord();
      if (following === "&") { commandPosition = true; index += 2; continue; }
      hasBackgroundJob = true; commandPosition = true; index++; continue;
    }
    if (char === "|") { finishWord(); commandPosition = true; index += source[index + 1] === "|" || source[index + 1] === "&" ? 2 : 1; continue; }
    if (char === ";" || char === "\n") { finishWord(); commandPosition = true; index++; continue; }
    if (/\s/.test(char) || char === "<" || char === ">") { finishWord(); index++; continue; }
    token.push(char); index++;
  }
  finishWord();
  const chunks: string[][] = [];
  for (const [word, atCommandPosition] of words) { if (atCommandPosition) chunks.push([]); chunks.at(-1)?.push(word); }
  return { commands: new Set(chunks.map(invokedCommandBasename).filter((word): word is string => word !== undefined).map((word) => word.toLowerCase())), hasBackgroundJob };
}


/** Conservatively identifies shell-level jobs that can escape managed ownership. */
export function classifyShellDetachment(command: string, runInBackground: boolean): ShellDetachmentKind {
  const { commands, hasBackgroundJob } = analyzeShellCommands(command);
  if (hasBackgroundJob && (runInBackground || commands.has("nohup") || commands.has("disown"))) return "service_detach";
  return hasBackgroundJob ? "ambiguous" : "none";
}
