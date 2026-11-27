#!/usr/bin/env bun

// Prints the tier rule's measures and result for each implementer task (ARCH-DIRECTORIES-022), from the committed
// records alone. A task that the rule ranks is committed as ranked only while its committed audit records each failure
// that separates settings as behavioral, and as floor until then; a task that the rule drops is committed as floor and
// reported. With --check it fails when a committed tier in bench/tasks/implement/tiers.json differs from that; with
// --write it commits those tiers and keeps each committed audit. A committed ranked task without an audit that holds
// fails every mode, because the ranking refuses it.

// A standalone process: it loads both module registries before anything reads the catalog.
import "../../scripts/shipped-modules.js";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkCatalog, type CommittedTier } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { judgeLabel } from "../../src/orchestration/modules/development/benchmark/records/benchmark-records.js";
import { committableTier, implementerTaskTiers } from "../../src/orchestration/modules/development/benchmark/records/task-tiers.js";
import { loadRankingInput } from "../../src/orchestration/modules/development/benchmark/persona/results-pages.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = "Usage: bun run bench:tiers [--check | --write]";

const measure = (value: number | undefined, digits: number) => value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits);

/** Print, check, or write the tiers; returns the lines to print and whether the run failed. */
export async function main(argv: readonly string[] = process.argv.slice(2), projectRoot = REPO_ROOT): Promise<{ lines: string[]; failed: boolean }> {
  const [mode, ...rest] = argv;
  if (rest.length > 0 || (mode !== undefined && mode !== "--check" && mode !== "--write")) throw new Error(`Unknown option: ${argv.join(" ")}. ${USAGE}`);
  const catalog = createBenchmarkCatalog(projectRoot);
  const committed = await catalog.implementTiers();
  const lines: string[] = [];
  const expected = new Map<string, CommittedTier>();
  const differs: string[] = [];
  const unaudited: string[] = [];
  for (const { role, judge, rows } of implementerTaskTiers(await loadRankingInput(catalog))) {
    lines.push(`## ${role} (cells pooled under ${judge ? judgeLabel(judge) : "no judge"})`, "", "| Task | Committed | Rule | Settings | Mean | Between | Noise | Between / noise |", "|---|---|---|---:|---:|---:|---:|---:|");
    for (const row of rows) {
      const ratio = row.between !== undefined && row.noise !== undefined && row.noise > 0 ? row.between / row.noise : undefined;
      lines.push(`| ${row.task} | ${row.committed ?? "none"} | ${row.rule} | ${row.settings} | ${measure(row.mean, 3)} | ${measure(row.between, 5)} | ${measure(row.noise, 5)} | ${measure(ratio, 2)} |`);
      const audit = committed.get(row.task)?.audit;
      const tier = committableTier(row.task, row.rule, audit);
      expected.set(row.task, { tier, ...(audit ? { audit } : {}) });
      if (row.rule === "ranked" && tier === "floor") unaudited.push(row.task);
      if (row.committed !== tier) differs.push(`- ${row.task}: committed ${row.committed ?? "none"}, the rule gives ${tier}${row.rule === "drop" ? " (drop)" : row.rule !== tier ? " (ranked once an audit holds)" : ""}`);
    }
    const dropped = rows.filter(({ rule }) => rule === "drop").map(({ task }) => task);
    lines.push("", dropped.length > 0 ? `Drop (neither separates settings nor checks a floor; committed as floor): ${dropped.join(", ")}` : "Drop: none.", "");
  }
  if (unaudited.length > 0) lines.push(`Ranked by the rule but floor until an audit records each separating failure as behavioral: ${unaudited.join(", ")}`, "");
  if (mode === "--write") {
    await writeFile(catalog.implementTiersFile, `${JSON.stringify(Object.fromEntries([...expected].sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
    return { lines: [...lines, `Wrote ${catalog.implementTiersFile}.`], failed: false };
  }
  const problems = differs.length > 0 ? [`${catalog.implementTiersFile} differs from the tier rule:`, ...differs, "Run `bun run bench:tiers --write` and commit the file."] : [];
  if (mode === "--check" && problems.length > 0) return { lines: [...lines, ...problems], failed: true };
  return { lines: [...lines, ...problems.length === 0 ? ["Every committed tier matches the rule, and every ranked task has a behavioral audit."] : problems], failed: false };
}

if (import.meta.main) {
  main().then(({ lines, failed }) => {
    (failed ? console.error : console.log)(lines.join("\n"));
    if (failed) process.exitCode = 1;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
