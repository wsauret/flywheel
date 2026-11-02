import { dirname, isAbsolute, resolve } from "node:path";

import { Lexer, type Token } from "marked";

/**
 * Finds the files that an AGENTS.md instruction file includes by mention.
 * A mention is an `@` that starts the text or follows white space, and the
 * word after it names a file. Flywheel reads only the prose of the Markdown:
 * fenced code, inline code, and the inside of HTML comments never include a
 * file, so a file can show an example mention without loading it.
 */

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

/** On Windows a backslash separates directories, so it is part of a mention.
 *  On other platforms a backslash is only part of a mention when it escapes a
 *  space; any other backslash ends the mention. */
const BACKSLASH_IN_PATH = process.platform === "win32";

/**
 * Returns, per mention in `content`, the absolute (lexically resolved, not
 * realpathed) candidate paths in fallback order. Importer-relative candidates
 * come first, with trailing-period variants after the verbatim path. A project
 * root adds the same fallback candidates only for bare relative mentions.
 * The caller takes the first candidate that exists. `filePath` anchors relative
 * mentions; `home` anchors `~/` mentions (Flywheel's account home, not
 * necessarily the OS home).
 */
export function extractMentionPaths(content: string, filePath: string, home: string, projectRoot?: string): string[][] {
  const baseDir = dirname(filePath);
  const byFirstCandidate = new Map<string, string[]>();
  for (const prose of proseOf(new Lexer({ gfm: false }).lex(content))) {
    for (const mention of mentionsIn(prose)) {
      const candidates = mentionCandidates(mention, baseDir, home, projectRoot);
      const first = candidates[0];
      if (first !== undefined && !byFirstCandidate.has(first)) byFirstCandidate.set(first, candidates);
    }
  }
  return [...byFirstCandidate.values()];
}

/** Walks Markdown tokens in document order.
 *  @yields {string} The text of each token that can hold a mention. Adjacent
 *  text and escape tokens are one run of prose. An escape keeps its source
 *  text: in `@C:\work\_shared\rules.md` Markdown reads `\_` as an escaped
 *  underscore, but on Windows that backslash separates two directories. */
function* proseOf(tokens: readonly Token[]): Generator<string> {
  let run: string | undefined;
  for (const token of tokens) {
    if (token.type === "escape") {
      run = (run ?? "") + token.raw;
      continue;
    }
    if (token.type === "text" && !("tokens" in token && token.tokens !== undefined)) {
      run = (run ?? "") + token.text;
      continue;
    }
    if (run !== undefined) yield run;
    run = undefined;
    switch (token.type) {
      case "code":
      case "codespan":
        continue;
      case "html":
        // Only an HTML token that starts with a closed comment contributes, and
        // only the text outside its comments. Other raw HTML holds no prose.
        if (token.raw.trimStart().startsWith(COMMENT_OPEN) && token.raw.includes(COMMENT_CLOSE)) yield withoutComments(token.raw);
        continue;
      case "text":
        yield token.text;
        break;
    }
    if ("tokens" in token && token.tokens !== undefined) yield* proseOf(token.tokens);
    if ("items" in token) yield* proseOf(token.items);
  }
  if (run !== undefined) yield run;
}

/** Removes each closed `<!-- ... -->` comment. An unclosed opener and the text after it stay. */
function withoutComments(html: string): string {
  let kept = "";
  let from = 0;
  for (;;) {
    const open = html.indexOf(COMMENT_OPEN, from);
    const close = open === -1 ? -1 : html.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length);
    if (close === -1) return kept + html.slice(from);
    kept += html.slice(from, open);
    from = close + COMMENT_CLOSE.length;
  }
}

/** Returns the path each mention in `text` names, with escaped spaces unescaped and a `#fragment` removed. */
function mentionsIn(text: string): string[] {
  const paths: string[] = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at === -1) break;
    index = at + 1;
    if (at > 0 && !isWhiteSpace(text.charAt(at - 1))) continue;
    let path = "";
    let fragment = false;
    let cursor = at + 1;
    while (cursor < text.length) {
      const character = text.charAt(cursor);
      if (character === "\\" && text.charAt(cursor + 1) === " ") {
        if (!fragment) path += " ";
        cursor += 2;
        continue;
      }
      if (isWhiteSpace(character) || (character === "\\" && !BACKSLASH_IN_PATH)) break;
      if (character === "#") fragment = true;
      if (!fragment) path += character;
      cursor += 1;
    }
    if (cursor === at + 1) continue;
    index = cursor;
    if (namesFile(path)) paths.push(path);
  }
  return paths;
}

/** The same characters that `String.prototype.trim` removes. */
function isWhiteSpace(character: string): boolean {
  return character.trim().length === 0;
}

/** True when `path` can name a file: it is home-relative, absolute below the
 *  root, or starts with a character that can start a relative file name. This
 *  keeps npm scopes (`@types/react`), handles (`@alice`), and punctuation out. */
function namesFile(path: string): boolean {
  if (path.startsWith("~/")) return true;
  if (path.startsWith("/")) return path.length > 1;
  return /^[\w.-]/.test(path);
}

/** Resolves a mention to its candidate paths. A path that ends in periods (a
 *  mention at the end of a sentence) also tries the path without them. */
function mentionCandidates(path: string, baseDir: string, home: string, projectRoot: string | undefined): string[] {
  const spellings = [path];
  const withoutPeriods = path.replace(/\.+$/, "");
  if (withoutPeriods !== path && namesFile(withoutPeriods)) spellings.push(withoutPeriods);
  const candidates = spellings.map((spelling) => (spelling.startsWith("~/") ? resolve(home, spelling.slice(2)) : resolve(baseDir, spelling)));
  if (projectRoot !== undefined && isBareRelative(path)) candidates.push(...spellings.map((spelling) => resolve(projectRoot, spelling)));
  return [...new Set(candidates)];
}

/** A relative path that does not start with `./`, `../`, or `~/`. */
function isBareRelative(path: string): boolean {
  return !isAbsolute(path) && !/^(?:\.{1,2}[\\/]|~\/)/.test(path);
}
