import { isAbsolute, sep, win32 } from "node:path";
import { physicalPathWithMissingTail } from "../../../infra/canonical-path.js";

export type ShellDialect = "bash" | "powershell";
export interface ExpandedWord {
  readonly value: string;
  readonly wildcard?: number;
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*/;
const BRACED_VARIABLE = /^\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}$`"'\\]*))?\}/;

/** Expand a shell word without executing it. Unknown expansions return null.
 * The first unquoted wildcard is retained separately from literal wildcards. */
export function expandShellWord(raw: string, lookup: (name: string) => string | null | undefined, dialect: ShellDialect): ExpandedWord | null {
  return expandWords(raw, lookup, dialect, false)?.[0] ?? null;
}

/** Expand argv words with Bash's default IFS. A changed IFS makes unquoted
 * expansion shape unknown, rather than silently selecting one filename. */
export function expandShellFields(raw: string, lookup: (name: string) => string | null | undefined, dialect: ShellDialect, changedIFS: boolean): readonly ExpandedWord[] | null {
  return expandWords(raw, lookup, dialect, dialect === "bash", changedIFS);
}

function expandWords(raw: string, lookup: (name: string) => string | null | undefined, dialect: ShellDialect, split: boolean, changedIFS = false): ExpandedWord[] | null {
  if (raw === "{}") return [{ value: raw }];
  if (raw && !/['"~$`\\*?[{]/.test(raw)) return [{ value: raw }];
  let value = "";
  let wildcard: number | undefined;
  const fields: ExpandedWord[] = [];
  let present = false;
  const finish = (): void => {
    if (present) fields.push({ value, ...(wildcard === undefined ? {} : { wildcard }) });
    value = "";
    wildcard = undefined;
    present = false;
  };
  let index = 0;
  let doubleQuoted = false;
  const append = (text: string, glob: boolean): void => {
    const first = glob ? text.search(/[*?[]/) : -1;
    if (wildcard === undefined && first >= 0) wildcard = value.length + first;
    value += text;
    present = true;
  };
  if (raw === "~" || raw.startsWith("~/") || (dialect === "powershell" && raw.startsWith("~\\"))) {
    const home = lookup("HOME");
    if (home === undefined || home === null) return null;
    value = home;
    present = true;
    index = 1;
  } else if (raw.startsWith("~")) return null;
  while (index < raw.length) {
    const char = raw.charAt(index);
    if (char === "'" && !doubleQuoted) {
      present = true;
      let end = raw.indexOf("'", index + 1);
      if (end < 0) return null;
      value += raw.slice(index + 1, end);
      if (dialect === "powershell") {
        while (raw[end + 1] === "'") {
          value += "'";
          index = end + 1;
          end = raw.indexOf("'", index + 1);
          if (end < 0) return null;
          value += raw.slice(index + 1, end);
        }
      }
      index = end + 1;
    } else if (char === '"') {
      present = true;
      doubleQuoted = !doubleQuoted;
      index++;
    } else if (char === "\\" && dialect === "bash") {
      const next = raw.charAt(index + 1);
      if (!next) return null;
      append(doubleQuoted && !'$`"\\'.includes(next) ? `\\${next}` : next, false);
      index += 2;
    } else if (char === "$") {
      const rest = raw.slice(index + 1);
      const env = dialect === "powershell" ? /^env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(rest) : null;
      const braced = env ? null : BRACED_VARIABLE.exec(rest);
      const simple = env || braced ? null : VARIABLE.exec(rest);
      const name = env?.[1] ?? braced?.[1] ?? simple?.[0];
      if (!name) return null;
      const found = lookup(name);
      if (found === null) return null;
      const operator = braced?.[2];
      const fallback = operator === ":-" ? found === undefined || found === "" : operator === "-" && found === undefined;
      const expanded = fallback ? braced?.[3] : found;
      if (expanded === undefined) return null;
      if (split && !doubleQuoted) {
        if (changedIFS) return null;
        for (const part of expanded.split(/([ \t\n]+)/)) {
          if (/^[ \t\n]+$/.test(part)) finish();
          else if (part) append(part, true);
        }
      } else append(expanded, !doubleQuoted);
      index += 1 + (env?.[0].length ?? braced?.[0].length ?? name.length);
    } else if (char === "`" || (!doubleQuoted && char === "{")) {
      return null;
    } else {
      append(char, !doubleQuoted);
      index++;
    }
  }
  if (doubleQuoted) return null;
  finish();
  return fields.length || split ? fields : [{ value: "" }];
}

/** Place a word physically. Globs use the static directory prefix and refuse
 * parent traversal after a wildcard. A foreign Windows drive stays absolute
 * when the PowerShell dialect is tested on a POSIX host. */
export function placeShellPath(word: ExpandedWord, cwd: string | null, dialect: ShellDialect, deleteEntry = false, linkCache?: Map<string, string | null>): string | null {
  let target = word.value;
  if (!target) return null;
  if (dialect === "powershell") target = target.replaceAll("\\", "/");
  if (word.wildcard !== undefined) {
    const tail = target.slice(word.wildcard);
    if (tail.split("/").includes("..")) return null;
    target = target.slice(0, target.lastIndexOf("/", word.wildcard) + 1) || ".";
  }
  if (dialect === "powershell" && (/^[A-Za-z]:/.test(target) || target.startsWith("//"))) {
    if (process.platform !== "win32") return win32.normalize(target).toLowerCase();
    target = target.replaceAll("/", "\\");
  }
  if (!isAbsolute(target)) {
    if (cwd === null) return null;
    target = `${cwd}${sep}${target}`;
  }
  try {
    const path = physicalPathWithMissingTail(target, deleteEntry && word.wildcard === undefined, linkCache);
    return dialect === "powershell" && process.platform === "win32" ? path.toLowerCase() : path;
  } catch {
    return null;
  }
}

/** Device destinations do not create filesystem writes. */
export function isShellSink(value: string, dialect: ShellDialect): boolean {
  return /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(value)
    || (dialect === "powershell" && /^(?:\$null|nul)$/i.test(value));
}
