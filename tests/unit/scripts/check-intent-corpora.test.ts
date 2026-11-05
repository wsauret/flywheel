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
const upd = (rest: string): string => ["UPD", rest].join("-");
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
const UPDATES = ["# Updates", "", `- \`${upd("001")}\`: Updates keep logins.`, ""].join("\n");
const CITING = `// Owned by ${arch("ALPHA-001")}, ${intent("BETA-001")}, and ${upd("001")}.\n`;

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

  it("rejects statements that do not follow their corpus format", () => {
    expect(check({
      ...CLEAN,
      "docs/architecture-intent/alpha.md": `${ALPHA}## ${arch("ALPHA-12")}: Short number\n`,
      "docs/product-intent/beta.md": `${BETA}## Grouping heading\n`,
      "docs/product-intent/updates.md": `${UPDATES}- \`${upd("02")}\`: Short number.\n`,
    })).toEqual([
      { file: "docs/architecture-intent/alpha.md", line: 6, rule: "statement-format" },
      { file: "docs/product-intent/beta.md", line: 6, rule: "statement-format" },
      { file: "docs/product-intent/updates.md", line: 4, rule: "statement-format" },
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

  it("rejects code spans, paths, and file names in architecture statements", () => {
    expect(check({
      ...CLEAN,
      "bin/launch": "#!/bin/sh\n",
      "docs/architecture-intent/alpha.md": `${ALPHA}The \`owner\` decides,\nlives in src/owner/,\nreads owner.ts first,\nand the reader and/or writer decides.\nIt starts from bin/launch.\n`,
    })).toEqual([
      { file: "docs/architecture-intent/alpha.md", line: 6, rule: "grain" },
      { file: "docs/architecture-intent/alpha.md", line: 7, rule: "grain" },
      { file: "docs/architecture-intent/alpha.md", line: 8, rule: "grain" },
      { file: "docs/architecture-intent/alpha.md", line: 10, rule: "grain" },
    ]);
  });

  it("caps a statement at four sentences, outside code spans, with one single-sentence rationale per label", () => {
    const four = "One owner decides. It writes the value. Readers wait. Writers stop.";
    const statement = (heading: string, ...body: string[]): string => `## ${heading}: Bounded\n\n${body.join("\n")}\n\n`;
    expect(check({
      ...CLEAN,
      "docs/architecture-intent/alpha.md": [
        ALPHA,
        statement(arch("ALPHA-002"), four, "Because: Two owners disagree, e.g. on replay.", "Not: A shared value."),
        statement(arch("ALPHA-003"), four, "Readers wait again."),
        statement(arch("ALPHA-005"), "One owner decides.", "Because: Two owners disagree.", "Because: Replay drifts."),
        statement(arch("ALPHA-006"), "One owner decides.", "Not: A shared value. A copy."),
        statement(arch("ALPHA-007"), "Because: Two owners disagree."),
        statement(arch("ALPHA-008"), "One owner decides.", "Because: Two owners disagree. Replay drifts."),
        statement(arch("ALPHA-009"), "One owner decides.", "Not: A shared value.", "Not: A copy."),
      ].join(""),
      "docs/product-intent/beta.md": [
        BETA,
        statement(intent("BETA-002"), "Press `stop. Then. Go.` once.", "It writes the value. Readers wait. Writers stop."),
        statement(intent("BETA-003"), "Work stays visible.", "Because: People lose track."),
        statement(intent("BETA-004"), "The client says \"Stopped.\""),
        statement(intent("BETA-006"), "Work stays visible.", "Not: A hidden queue."),
        statement(intent("BETA-005"), "It says \"One.\" It says \"Two.\" It says \"Three.\" It says \"Four.\" It stops."),
      ].join(""),
    })).toEqual([
      { file: "docs/architecture-intent/alpha.md", line: 12, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 17, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 23, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 28, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 32, rule: "length" },
      { file: "docs/architecture-intent/alpha.md", line: 37, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 11, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 20, rule: "length" },
      { file: "docs/product-intent/beta.md", line: 25, rule: "length" },
    ]);
  });

  it("rejects citations of missing statements and of retired records in any listed file", () => {
    expect(check({
      ...CLEAN,
      "src/owner.ts": `${CITING}// Also ${arch("ALPHA-002")}.\n// See ${records}/x.md and ${adr("005").toLowerCase()}.\n`,
      "AGENTS.md": `Follow ${upd("009")}.\n`,
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
