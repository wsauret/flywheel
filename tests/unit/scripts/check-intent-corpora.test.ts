import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkIntentCorpora } from "../../../scripts/check-intent-corpora.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

// Identifiers and record citations are assembled at run time so that this file
// does not itself cite a statement or a retired record when the gate scans it.
const arch = (rest: string): string => ["ARCH", rest].join("-");
const intent = (rest: string): string => ["PI", rest].join("-");
const adr = (rest: string): string => ["ADR", rest].join("-");
const records = ["docs", "adrs"].join("/");

const ARCHITECTURE_README = [
  "# Architecture Intent",
  "",
  "Product intent (`docs/product-intent/`) states the experience.",
  "",
  "- [Alpha](alpha.md): the alpha domain.",
  "",
].join("\n");
const ALPHA = [
  "# Alpha",
  "",
  `## ${arch("ALPHA-001")}: One owner per value`,
  "",
  "Each value has one owner.",
  "",
].join("\n");
const PRODUCT_README = ["# Product Intent", "", "- [Beta](beta.md): beta.", "- [Updates](updates.md): updates.", ""].join("\n");
const BETA = ["# Beta", "", `## ${intent("BETA-001")}: People see their work`, "", "Work stays visible.", ""].join("\n");
const UPDATES = ["# Updates", "", `## ${intent("UPDATES-001")}: Updates keep logins`, "", "Updates keep logins.", ""].join("\n");
const CITING = `// Owned by ${arch("ALPHA-001")}, ${intent("BETA-001")}, and ${intent("UPDATES-001")}.\n`;

const CLEAN = {
  "docs/architecture-intent/README.md": ARCHITECTURE_README,
  "docs/architecture-intent/alpha.md": ALPHA,
  "docs/product-intent/README.md": PRODUCT_README,
  "docs/product-intent/beta.md": BETA,
  "docs/product-intent/updates.md": UPDATES,
  "src/owner.ts": CITING,
  "docs/research/old-audit.md": `See ${records} and ${arch("GONE-001")}.\n`,
};

function check(tree: { readonly [file: string]: string }): { file: string; line: number; rule: string }[] {
  const root = temporaryDirectory("flywheel-intent-corpora-");
  for (const [file, text] of Object.entries(tree)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return checkIntentCorpora(root, Object.keys(tree)).map(({ file, line, rule }) => ({ file, line, rule }));
}

describe("check-intent-corpora", () => {
  it("accepts coherent corpora, resolved citations, and excluded research", () => {
    expect(check(CLEAN)).toEqual([]);
  });

  it("rejects statements that do not follow their corpus format and any heading but the title and statements", () => {
    expect(check({
      ...CLEAN,
      "docs/architecture-intent/alpha.md": `${ALPHA}## ${arch("ALPHA-12")}: Short number\n`,
      // The last "---" follows a blank line, so it is a thematic break.
      "docs/product-intent/beta.md": `${BETA}## Grouping heading\n\n   ## Indented heading\n\nSetext title\n===\n\nSetext section\n---\n\n---\n`,
      "docs/product-intent/updates.md": `${UPDATES}### Older updates\n\n# Second title\n`,
    })).toEqual([
      { file: "docs/architecture-intent/alpha.md", line: 6, rule: "statement-format" },
      { file: "docs/product-intent/beta.md", line: 6, rule: "statement-format" },
      { file: "docs/product-intent/beta.md", line: 8, rule: "statement-format" },
      { file: "docs/product-intent/beta.md", line: 10, rule: "statement-format" },
      { file: "docs/product-intent/beta.md", line: 13, rule: "statement-format" },
      { file: "docs/product-intent/updates.md", line: 6, rule: "statement-format" },
      { file: "docs/product-intent/updates.md", line: 8, rule: "statement-format" },
    ]);
  });

  it("rejects a statement id stated twice", () => {
    expect(check({
      ...CLEAN,
      "docs/architecture-intent/alpha.md": `${ALPHA}## ${arch("ALPHA-001")}: Restated\n\nRestated.\n`,
    })).toEqual([{ file: "docs/architecture-intent/alpha.md", line: 6, rule: "duplicate-id" }]);
  });

  it("rejects a linked domain file that does not exist and a domain file that is not linked", () => {
    expect(check({
      ...CLEAN,
      "docs/architecture-intent/README.md": `${ARCHITECTURE_README}- [Gamma](gamma.md): missing.\n`,
      "docs/product-intent/delta.md": `# Delta\n\n## ${intent("DELTA-001")}: Unlinked\n\nUnlinked.\n`,
    })).toEqual([
      { file: "docs/architecture-intent/README.md", line: 6, rule: "domain-link" },
      { file: "docs/product-intent/delta.md", line: 1, rule: "domain-link" },
    ]);
  });

  it("rejects code spans, paths, and file names in statements of either corpus", () => {
    const leaks = "The `owner` decides,\nlives in src/owner/,\nreads owner.ts first,\nand the reader and/or writer decides.\nIt starts from bin/launch.\n";
    expect(check({
      ...CLEAN,
      "bin/launch": "#!/bin/sh\n",
      "docs/architecture-intent/alpha.md": `${ALPHA}${leaks}`,
      "docs/product-intent/beta.md": `${BETA}${leaks}`,
    })).toEqual([
      { file: "docs/architecture-intent/alpha.md", line: 6, rule: "grain" },
      { file: "docs/architecture-intent/alpha.md", line: 7, rule: "grain" },
      { file: "docs/architecture-intent/alpha.md", line: 8, rule: "grain" },
      { file: "docs/architecture-intent/alpha.md", line: 10, rule: "grain" },
      { file: "docs/product-intent/beta.md", line: 6, rule: "grain" },
      { file: "docs/product-intent/beta.md", line: 7, rule: "grain" },
      { file: "docs/product-intent/beta.md", line: 8, rule: "grain" },
      { file: "docs/product-intent/beta.md", line: 10, rule: "grain" },
    ]);
  });

  it("caps a statement at 100 body words in sentences of at most 35 words, with one single-sentence rationale per label, and ends no sentence at an abbreviation", () => {
    // A sentence of exactly `count` words that ends with `end`.
    const sentence = (count: number, end = "now."): string => ["Readers", ...Array.from({ length: count - 2 }, () => "wait"), end].join(" ");
    const statement = (heading: string, ...body: string[]): string => `## ${heading}: Bounded\n\n${body.join("\n")}\n\n`;
    // A code span counts as one word; the grain rule rejects it separately.
    expect(check({
      ...CLEAN,
      "docs/architecture-intent/alpha.md": [
        ALPHA,
        statement(arch("ALPHA-002"), "One owner decides. It writes the value. Readers wait. Writers stop. Nothing else runs.", "Because: Two owners disagree, e.g. on replay.", "Not: A shared value."),
        statement(arch("ALPHA-003"), Array.from({ length: 5 }, () => sentence(21)).join(" ")),
        statement(arch("ALPHA-004"), `One owner decides. ${sentence(36, "now")}`),
        statement(arch("ALPHA-005"), "One owner decides.", "Because: Two owners disagree.", "Because: Replay drifts."),
        statement(arch("ALPHA-006"), "One owner decides.", "Not: A shared value. A copy."),
        statement(arch("ALPHA-007"), "Because: Two owners disagree."),
        statement(arch("ALPHA-008"), "One owner decides.", `Because: ${sentence(36)}`),
        statement(arch("ALPHA-009"), "One owner decides.", "Not: A shared value.", "Not: A copy."),
      ].join(""),
      "docs/product-intent/beta.md": [
        BETA,
        statement(intent("BETA-002"), `${sentence(34, "`git log --oneline --all`")} now.`),
        statement(intent("BETA-003"), "Work stays visible.", "Because: People lose track."),
        statement(intent("BETA-004"), `${sentence(20, "\"Stopped.\"")} ${sentence(20)}`),
        statement(intent("BETA-005"), "Work stays visible.", "Not: A hidden queue."),
        statement(intent("BETA-006"), `${sentence(20, "e.g.")} ${sentence(20)}`),
        statement(intent("BETA-007"), `${sentence(20, "Vs.")} ${sentence(20)}`),
        statement(intent("BETA-008"), `${sentence(20)} 12 ${sentence(19)}`),
      ].join(""),
    }).filter(({ rule }) => rule === "length")).toEqual([
      { file: "docs/architecture-intent/alpha.md", line: 12, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 16, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 20, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 26, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 31, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 35, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 40, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 10, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 19, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 24, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 28, rule: "length" },
    ]);
  });

  it("rejects citations of missing statements and of retired records in any listed file", () => {
    expect(check({
      ...CLEAN,
      "src/owner.ts": `${CITING}// Also ${arch("ALPHA-002")}.\n// See ${records}/x.md and ${adr("005").toLowerCase()}.\n`,
      "AGENTS.md": `Follow ${intent("UPDATES-009")}.\n`,
      "install.sh": `# See ${adr("014")}.\n`,
    })).toEqual([
      { file: "src/owner.ts", line: 2, rule: "dangling-id" },
      { file: "src/owner.ts", line: 3, rule: "adr-reference" },
      { file: "src/owner.ts", line: 3, rule: "adr-reference" },
      { file: "AGENTS.md", line: 1, rule: "dangling-id" },
      { file: "install.sh", line: 1, rule: "adr-reference" },
    ]);
  });
});
