import * as fs from "node:fs";
import * as path from "node:path";
import { declaredFactRetentionTypes, declaredRetiredFactTypes, factOwner, factRetention, type FactOwner, type FactRetention } from "../src/infra/fact-retention-registry.js";
import { DEVELOPMENT_MODULES } from "../src/orchestration/development-modules.js";
import { SHIPPED_MODULES, type FirstPartyModule } from "../src/orchestration/modules.js";
import { RETIRED_FACT_TYPES } from "../src/orchestration/session/event-store-maintenance.js";
import { isUnderAny, moduleFactHomes } from "./module-homes.js";

// Every durable fact family must declare its retention policy and its owner
// in src/infra/fact-retention-registry.ts. The policy decides whether a family
// accumulates: a per-revision family declared "history" by omission is how
// 90,335 chat provisionals and a lease renewed every ~100 seconds piled up
// with no reader. The owner decides where the family lives: a module's
// families are defined under its fact home and carry its declared prefixes,
// so the module-containment gate can hold the family inside the module. This
// gate makes both declarations a build failure, exactly as lint:diagnostics
// does for record tiers. Retired prunable families keep only their declaration
// so old rows stay removable after the active schema is deleted. The gate
// enforces that the answers exist and agree, not that the policy is right;
// that judgment stays in review against ARCH-SUBSTRATE-024 "In-flight state is a hold, not history".

/** What the gate reads from the registry and the module catalog, so a test
 *  can run it over a fixture tree with a synthetic registry. */
export interface FactRetentionRegistry {
  retention(type: string): FactRetention | undefined;
  owner(type: string): FactOwner | undefined;
  declaredTypes(): readonly string[];
  retiredTypes(): readonly string[];
  /** The families `--prune-retired` drops. */
  readonly prunable: readonly string[];
  /** The fact prefixes a module declares, or undefined when it declares none. */
  prefixes(module: string): readonly string[] | undefined;
}

const DEFINITION_PATTERN = /defineFact\(\{\s*\n?\s*type:\s*"([^"]+)"|defineRuntimeFact\(\{\s*\n?\s*type:\s*"([^"]+)"/g;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Every defined fact type and the repository-relative file that first defines it. */
function definedTypes(repoRoot: string): Map<string, string> {
  const defined = new Map<string, string>();
  for (const file of sourceFiles(path.join(repoRoot, "src"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(DEFINITION_PATTERN)) {
      const type = match[1] ?? match[2];
      if (type !== undefined && !defined.has(type)) defined.set(type, path.relative(repoRoot, file).split(path.sep).join("/"));
    }
  }
  return defined;
}

/** The gate's answer: every violation it found and how many families it classified. */
export interface FactRetentionReport {
  readonly failures: readonly string[];
  readonly classified: number;
}

export function findFactRetentionViolations(repoRoot: string, registry: FactRetentionRegistry): FactRetentionReport {
  const failures: string[] = [];
  const defined = definedTypes(repoRoot);

  for (const [type, file] of defined) {
    if (!registry.retention(type)) {
      failures.push(`undeclared fact family: "${type}" (${file}) has no retention policy in src/infra/fact-retention-registry.ts`);
      continue;
    }
    const owner = registry.owner(type);
    if (owner === undefined || owner === "kernel") continue;
    if (!isUnderAny(file, moduleFactHomes(owner))) {
      failures.push(`"${type}" is owned by ${owner} but is defined in ${file}, outside that module's fact home (${moduleFactHomes(owner).join(", ")})`);
    }
    const prefixes = registry.prefixes(owner);
    if (prefixes === undefined) {
      failures.push(`"${type}" is owned by ${owner}, which declares no fact prefixes in its module descriptor`);
    } else if (!prefixes.some((prefix) => type.startsWith(prefix))) {
      failures.push(`"${type}" is owned by ${owner} but carries none of its declared fact prefixes (${prefixes.join(", ")})`);
    }
  }

  for (const type of registry.declaredTypes()) {
    if (!defined.has(type)) {
      const retention = registry.retention(type)
      if (retention?.policy === "retired" && registry.prunable.includes(type)) continue
      failures.push(`stale declaration: "${type}" is classified in src/infra/fact-retention-registry.ts but no defineFact/defineRuntimeFact schema defines it`);
    }
  }

  // A "retired" declaration and RETIRED_FACT_TYPES must agree, or --prune-retired
  // and the registry would tell two different stories about the same family.
  const prunable = new Set(registry.prunable);
  for (const type of registry.retiredTypes()) {
    if (!prunable.has(type)) {
      failures.push(`"${type}" is declared retired but is missing from RETIRED_FACT_TYPES (src/orchestration/session/event-store-maintenance.ts)`);
    }
  }
  for (const type of registry.prunable) {
    const retention = registry.retention(type);
    if (!retention) {
      failures.push(`"${type}" is in RETIRED_FACT_TYPES but has no retention declaration`);
    } else if (retention.policy !== "retired") {
      failures.push(`"${type}" is in RETIRED_FACT_TYPES but the registry declares it "${retention.policy}"`);
    }
  }

  return { failures, classified: defined.size };
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const { failures, classified } = findFactRetentionViolations(repoRoot, {
    retention: factRetention,
    owner: factOwner,
    declaredTypes: declaredFactRetentionTypes,
    retiredTypes: declaredRetiredFactTypes,
    prunable: RETIRED_FACT_TYPES,
    prefixes: (module) => {
      const owner: FirstPartyModule | undefined = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES].find((candidate) => candidate.id === module);
      return owner?.facts?.prefixes;
    },
  });

  if (failures.length > 0) {
    for (const failure of failures) console.error(`fact-retention: ${failure}`);
    console.error(`\nfact-retention: ${failures.length} problem(s). Classify the family under its owner in src/infra/fact-retention-registry.ts and define it under that owner's fact home; a checkpoint (state retired by its outcome) belongs in the in_flight table, not the log.`);
    process.exit(1);
  }

  console.log(`fact-retention: ${classified} fact families classified`);
}
