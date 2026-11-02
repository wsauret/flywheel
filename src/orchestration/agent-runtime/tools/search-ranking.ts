/**
 * Ranking stage for content search: byte-level definition/import classifiers
 * (adapted from the hand-rolled scanner in fff's `grep.rs`, MIT; credited in
 * THIRD-PARTY-NOTICES.md), a soft path-class scorer, and the
 * pure `rankMatches` stage that wraps each match in a RankedMatch value.
 *
 * No stage mutates the shared GrepMatch graph. The definition verdict is
 * computed once per match and carried on the RankedMatch value, never written
 * back onto the input.
 */

import type { GrepMatch } from "./ripgrep.js";

/** Modifier keywords that can precede a definition keyword. Each must be
 *  followed by whitespace to be consumed (port of fff grep.rs MODIFIERS). */
const MODIFIERS = [
  "pub", "export", "default", "async", "abstract",
  "unsafe", "static", "protected", "private", "public",
] as const;

/** Definition keywords to detect (port of fff grep.rs DEF_KEYWORDS). */
const DEF_KEYWORDS = [
  "struct", "fn", "enum", "trait", "impl", "class",
  "interface", "function", "def", "func", "type", "module", "object",
] as const;

/** ASCII whitespace test, matching Rust's `is_ascii_whitespace`: space, tab,
 *  newline, carriage return, form feed, vertical tab. A small char test rather
 *  than a regex keeps parity and avoids per-call regex allocation. */
function isAsciiWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** Skip a leading run of ASCII whitespace (port of fff grep.rs skip_ws). */
function skipWs(s: string): string {
  let n = 0;
  while (n < s.length && isAsciiWs(s.charAt(n))) n++;
  return s.slice(n);
}

/** Skip zero or more modifier keywords, including `pub(crate)`-style
 *  visibility (port of fff grep.rs skip_modifiers). */
function skipModifiers(input: string): string {
  let s = input;
  for (;;) {
    // Handle `pub(...)` - e.g. `pub(crate)`, `pub(super)`.
    if (s.startsWith("pub(")) {
      const end = s.indexOf(")");
      if (end !== -1) {
        s = skipWs(s.slice(end + 1));
        continue;
      }
    }
    let matched = false;
    for (const kw of MODIFIERS) {
      if (s.startsWith(kw)) {
        const rest = s.slice(kw.length);
        // Indexing past the end returns "", whose char fails the ws test,
        // matching Rust's `rest.first().is_some_and(...)`.
        if (rest.length > 0 && isAsciiWs(rest.charAt(0))) {
          s = skipWs(rest);
          matched = true;
          break;
        }
      }
    }
    if (!matched) return s;
  }
}

/** Check if `s` starts with a definition keyword followed by a word boundary:
 *  end of input, or next char is not [A-Za-z0-9_] (port of fff
 *  grep.rs is_definition_keyword; `"".charCodeAt(0)` is NaN, failing every
 *  alphanumeric test, matching `is_none_or`). */
function isDefinitionKeyword(s: string): boolean {
  for (const kw of DEF_KEYWORDS) {
    if (s.startsWith(kw)) {
      const code = s.charCodeAt(kw.length);
      const isWordChar =
        (code >= 48 && code <= 57) || // 0-9
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122) || // a-z
        code === 95; // _
      if (!isWordChar) return true;
    }
  }
  return false;
}

/** Detect if a line looks like a code definition (struct, fn, class, etc.).
 *  Hand-rolled keyword scanner - avoids regex overhead; strips optional
 *  visibility/modifier keywords, then checks the next token is a definition
 *  keyword followed by a word boundary (port of fff grep.rs is_definition_line). */
export function isDefinitionLine(line: string): boolean {
  return isDefinitionKeyword(skipModifiers(line.trimStart()));
}

/** Match `require(` or `require (` (port of fff grep.rs starts_with_require). */
function startsWithRequire(s: string): boolean {
  if (!s.startsWith("require")) return false;
  const rest = s.slice("require".length);
  return rest.charAt(0) === "(" || (rest.charAt(0) === " " && rest.charAt(1) === "(");
}

/** Match `#include ` with optional spaces after `#` (port of fff
 *  grep.rs starts_with_include). */
function startsWithInclude(s: string): boolean {
  if (s.charAt(0) !== "#") return false;
  const rest = skipWs(s.slice(1));
  return rest.startsWith("include ") || rest.startsWith("include\t");
}

/** Detect import/use lines - lower value than definitions or usages. Pure
 *  char-level checks, no regex (port of fff grep.rs is_import_line). */
export function isImportLine(line: string): boolean {
  const s = line.trimStart();
  return (
    s.startsWith("import ") ||
    s.startsWith("import\t") ||
    (s.startsWith("from ") && (s.charAt(5) === "'" || s.charAt(5) === '"')) ||
    s.startsWith("use ") ||
    s.startsWith("use\t") ||
    startsWithRequire(s) ||
    startsWithInclude(s)
  );
}

/** Soft path class: source files rank ahead of tests, tests ahead of vendored
 *  /generated code. A discriminated class over a bag of optional booleans
 *  (entire.io's "source-over-test/vendor" recommendation as a soft score). */
type PathClass = "source" | "test" | "vendor";

interface PathClassWeights {
  source: number;
  test: number;
  vendor: number;
}

const PATH_CLASS_WEIGHT: PathClassWeights = { source: 0, test: 1, vendor: 2 };

const VENDOR_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules", "vendor", "dist", "build", ".next", "generated", "target", "__generated__",
]);

const TEST_SEGMENTS: ReadonlySet<string> = new Set([
  "test", "tests", "__tests__", "__mocks__", "fixtures", "__fixtures__", "spec",
]);

/** Match a `*.infix.*` filename glob: the infix appears with a name before it
 *  and an extension after it (e.g. `foo.min.js` matches `.min.`). */
function hasInfix(name: string, infix: string): boolean {
  const at = name.indexOf(infix);
  return at > 0 && at + infix.length < name.length;
}

/** Classify a display path by segment (lowercased), never raw substring, so
 *  `src/testing-utils.ts` stays source. Vendor/generated wins over test. */
export function classifyPath(displayPath: string): PathClass {
  const segments = displayPath.toLowerCase().split("/");
  const fileName = segments[segments.length - 1] ?? "";
  for (const seg of segments) {
    if (VENDOR_SEGMENTS.has(seg)) return "vendor";
  }
  // *.min.* filename -> vendor (minified/generated).
  if (hasInfix(fileName, ".min.")) return "vendor";
  for (const seg of segments) {
    if (TEST_SEGMENTS.has(seg)) return "test";
  }
  // *.test.* / *.spec.* filename -> test.
  if (hasInfix(fileName, ".test.") || hasInfix(fileName, ".spec.")) {
    return "test";
  }
  return "source";
}

/** Path-class weight. `invert` negates it so a deliberate test/fixture search
 *  can promote tests. Soft: only reorders, never filters - no path is dropped. */
export function pathWeight(displayPath: string, invert: boolean): number {
  const w = PATH_CLASS_WEIGHT[classifyPath(displayPath)];
  return invert ? -w : w;
}

export type RankTier = 0 | 1 | 2; // definition | usage | import

export interface RankedMatch {
  readonly match: GrepMatch; // the original, never mutated
  readonly isDefinition: boolean;
  readonly tier: RankTier;
}

export interface RankOptions {
  readonly rankingEnabled: boolean;
  readonly preferTests: boolean; // path-weight inversion; default false
}

export function tierForMatch(match: GrepMatch): RankTier {
  if (isDefinitionLine(match.line)) return 0;
  return isImportLine(match.line) ? 2 : 1;
}

export function rankMatches(matches: readonly GrepMatch[], opts: RankOptions): RankedMatch[] {
  // Classify every match the same way in both modes; the verdict is true state,
  // not a function of whether reordering is enabled. Identity mode keeps input
  // ORDER and forces tier 1 (no reorder), but isDefinition still reflects the
  // ACTUAL classification so the [def] summary tag never lies when ranking is off.
  if (!opts.rankingEnabled) {
    return matches.map((match): RankedMatch => ({
      match,
      isDefinition: isDefinitionLine(match.line),
      tier: 1,
    }));
  }
  const ranked = matches.map((match): RankedMatch => {
    const tier = tierForMatch(match);
    return { match, isDefinition: tier === 0, tier };
  });
  // Stable sort: tier primary, path weight secondary, input order the tiebreaker.
  // Sort an index-tagged projection so the input array is never sorted in place.
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) =>
      a.r.tier - b.r.tier ||
      pathWeight(a.r.match.path, opts.preferTests) - pathWeight(b.r.match.path, opts.preferTests) ||
      a.i - b.i)
    .map(({ r }) => r);
}
