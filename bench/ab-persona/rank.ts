#!/usr/bin/env bun

// Ranks every benchmarked role from the committed benchmark records
// (ARCH-DIRECTORIES-021). It reads only record files and the catalog: no
// runtime, no profile, no provider request. It prints the policy that the
// records imply and leaves ROLE_MODEL_DEFAULTS to an approved change.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectStartupDirectories } from "../../src/infra/directory-authorities.js";
import { modelPriceTier } from "../../src/orchestration/config/model-tiers.js";
import { ROLE_MODEL_DEFAULTS, roleModelPreferences } from "../../src/orchestration/config/role-model-defaults.js";
import { loadAllCampaignRecords } from "../../src/orchestration/modules/development/benchmark/benchmark-records.js";
import { benchmarkMode, createBenchmarkCatalog } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { planTasks, scoringVersion } from "../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { rankBenchmarkRecords, rankingCorpus, renderRanking, type RankingCorpus, type RankingFamily } from "../../src/orchestration/modules/development/benchmark/ranking.js";
import { parseVariant } from "../../src/orchestration/modules/development/benchmark/variant.js";
import { getPersonaMetadataIndex } from "../../src/workflows/agents/agent-roles.js";

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
  const catalog = createBenchmarkCatalog(projectRoot);
  const campaigns = await loadAllCampaignRecords(catalog.recordsRoot);
  const personas = getPersonaMetadataIndex();
  const corpora = new Map<string, RankingCorpus>();
  for (const persona of new Set(campaigns.map(({ header }) => header.persona))) {
    const mode = benchmarkMode(persona);
    corpora.set(persona, rankingCorpus(persona, mode, await planTasks(persona, mode, catalog)));
  }
  const { userDataRoot } = selectStartupDirectories({ projectRootOption: projectRoot, env: process.env, cwd: projectRoot });
  const families: readonly RankingFamily[] = ["openai", "anthropic"];
  const rankings = rankBenchmarkRecords({
    campaigns,
    roleOf: (persona) => personas[persona]?.role,
    corpora,
    scoringVersion,
    classify: (model) => {
      for (const family of families) {
        const tier = modelPriceTier(model, family, { userDataRoot });
        if (tier !== "default") return { family, tier };
      }
      return { family: undefined, tier: undefined };
    },
    entryOf: (role) => Object.entries(ROLE_MODEL_DEFAULTS).find(([, entry]) => entry === roleModelPreferences(role))![0],
    ...(args.roles.length > 0 ? { roles: args.roles } : {}),
    ...(args.judge ? { judge: args.judge } : {}),
  });
  return renderRanking(rankings);
}

if (import.meta.main) {
  main().then((text) => console.log(text), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
