#!/usr/bin/env bun

// Writes the committed results page of every benchmarked persona from its
// record files (ARCH-DIRECTORIES-023), or with --check fails on each page that
// is missing or differs from what the records give. It reads only record files
// and the catalog: no runtime, no profile, no provider request.

// A standalone process: it loads both module registries before anything reads the catalog.
import "../../scripts/shipped-modules.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkCatalog } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { loadRankingInput, renderResultsPages, staleResultsPages, writeResultsPages } from "../../src/orchestration/modules/development/benchmark/persona/results-pages.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Write or check the pages; returns the lines to print and whether the run failed. */
export async function main(argv: readonly string[] = process.argv.slice(2), projectRoot = REPO_ROOT): Promise<{ lines: string[]; failed: boolean }> {
  const check = argv.length === 1 && argv[0] === "--check";
  if (argv.length > 0 && !check) throw new Error(`Unknown option: ${argv.join(" ")}. Usage: bun run bench:tables [--check]`);
  const catalog = createBenchmarkCatalog(projectRoot);
  const pages = renderResultsPages(await loadRankingInput(catalog));
  if (check) {
    const stale = await staleResultsPages(catalog.tablesRoot, pages);
    return stale.length === 0
      ? { lines: [`${pages.size} benchmark results pages match their records.`], failed: false }
      : { lines: [...stale, "Regenerate them with `bun run bench:tables` and commit them with their records."], failed: true };
  }
  const written = await writeResultsPages(catalog.tablesRoot, pages);
  return { lines: [`Wrote ${written.length} of ${pages.size} benchmark results pages.`, ...written], failed: false };
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
