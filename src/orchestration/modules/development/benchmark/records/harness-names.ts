import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

// The maintainer's lint of other coding agents' names, read at run time. The
// public tree names no such agent, so this module holds no copy of the term
// list: it parses the list out of the private lint when the checkout has the
// companion folder, and a contributor's clone has neither the list nor the
// lint that would fail on a name. Benchmark records and recorded reviewer
// fixtures are the two publications that quote model output, and both scrub
// it through this one loader.

/** Where the private lint sits in a checkout. */
export function harnessLintFile(repo: string): string {
  return join(repo, "private", "scripts", "check-harness-names.ts");
}

/** The maintainer's harness-name lint. */
export interface HarnessLint {
  /** `text` with every line that the lint flags rewritten: each term match
   *  becomes `word(termIndex)`, and wire identifiers stay as they are. Returns
   *  the count of rewritten lines. */
  scrub(text: string, word: (termIndex: number) => string): { text: string; lines: number };
  /** The lint's violation count over files, given by absolute path. */
  violations(files: readonly string[]): number;
}

/** One regular expression literal per line of the named array in `source`. */
function regexArray(source: string, name: string): RegExp[] {
  const body = new RegExp(`const ${name}: readonly RegExp\\[\\] = \\[\\n([\\s\\S]*?)\\n\\];`).exec(source)?.[1];
  const terms = (body ?? "").split("\n").flatMap((line) => {
    const literal = /^\s*\/(.+)\/([a-z]*),\s*$/.exec(line);
    return literal?.[1] === undefined ? [] : [new RegExp(literal[1], literal[2])];
  });
  if (terms.length === 0) throw new Error(`The harness-name lint has no readable ${name} array`);
  return terms;
}

/** Load the lint at `path`, or undefined when the checkout has none. */
export async function loadHarnessLint(repo: string, path: string): Promise<HarnessLint | undefined> {
  if (!existsSync(path)) return undefined;
  const source = await readFile(path, "utf8");
  const terms = regexArray(source, "HARNESS_TERMS");
  const wire = regexArray(source, "WIRE_IDENTIFIERS");
  // The lint removes whole-line wire shapes before identifier tokens.
  const wireOrder = [...wire.filter((item) => item.source.startsWith("^")), ...wire.filter((item) => !item.source.startsWith("^"))];
  const globalTerms = terms.map((term) => new RegExp(term.source, term.flags.includes("g") ? term.flags : `${term.flags}g`));
  const module: unknown = await import(path);
  if (typeof module !== "object" || module === null || !("findHarnessNames" in module) || typeof module.findHarnessNames !== "function") {
    throw new Error(`${path} exports no findHarnessNames`);
  }
  const findHarnessNames = module.findHarnessNames;
  return {
    scrub(text, word) {
      let lines = 0;
      const scrubbed = text.split("\n").map((line) => {
        // Each wire identifier becomes a placeholder, in the lint's order, so
        // the terms are found and replaced only outside it and it comes back
        // unchanged. The lint skips text with a NUL, so no line holds one.
        const kept: string[] = [];
        const rest = wireOrder.reduce((current, identifier) => current.replace(identifier, (match) => `\0${kept.push(match) - 1}\0`), line);
        if (!terms.some((term) => term.test(rest))) return line;
        lines++;
        // SAFETY: every placeholder indexes `kept`, because the line held no NUL before the wire pass added them.
        return globalTerms.reduce((current, term, index) => current.replace(term, word(index)), rest).replace(/\0(\d+)\0/g, (_, index: string) => kept[Number(index)]!);
      });
      return { text: scrubbed.join("\n"), lines };
    },
    violations(files) {
      const found: unknown = findHarnessNames(repo, files.map((file) => relative(repo, file)));
      if (!Array.isArray(found)) throw new Error(`${path} findHarnessNames returned no list`);
      return found.length;
    },
  };
}
