#!/usr/bin/env bun

// Ranks every benchmarked role from the committed benchmark records
// (ARCH-DIRECTORIES-021). It reads only record files and the catalog: no
// runtime, no profile, no provider request. It prints the policy that the
// records imply and leaves ROLE_MODEL_DEFAULTS to an approved change.

// A standalone process: it loads both module registries before anything reads the catalog.
import "../../scripts/shipped-modules.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkCatalog } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { rankBenchmarkRecords, renderRanking } from "../../src/orchestration/modules/development/benchmark/records/ranking.js";
import { loadRankingInput } from "../../src/orchestration/modules/development/benchmark/persona/results-pages.js";
import { parseVariant } from "../../src/orchestration/modules/development/benchmark/variant.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface RankArgs {
  roles: string[];
  judge?: { model: string; effort: string };
}

export function parseRankArgs(argv: readonly string[]): RankArgs {
  const roles: string[] = [];
  let judge: RankArgs["judge"];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--role" || arg === "--judge") {
      if (!value) throw new Error(`${arg} requires a value`);
      index++;
      if (arg === "--role") roles.push(value);
      else {
        const parsed = parseVariant(value);
        judge = { model: parsed.model, effort: parsed.effort };
      }
    } else {
      throw new Error(`Unknown option: ${arg}. Usage: bun run bench:rank [--role <role>]... [--judge <model>:<effort>]`);
    }
  }
  return { roles, ...(judge ? { judge } : {}) };
}

export async function main(argv: readonly string[] = process.argv.slice(2), projectRoot = REPO_ROOT): Promise<string> {
  const args = parseRankArgs(argv);
  const input = await loadRankingInput(createBenchmarkCatalog(projectRoot));
  return renderRanking(rankBenchmarkRecords({
    ...input,
    ...(args.roles.length > 0 ? { roles: args.roles } : {}),
    ...(args.judge ? { judge: args.judge } : {}),
  }));
}

if (import.meta.main) {
  main().then((text) => console.log(text), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
