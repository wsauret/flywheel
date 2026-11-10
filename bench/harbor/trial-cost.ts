import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSqliteEventReadSurface } from "../../src/infra/sqlite-event-read-surface.js";
import { isMissingFile } from "./analysis/json.js";
import { decodeTrialStoreAnalysis, TRIAL_STORE_ANALYSIS_NAME, usageSummary, type UsageSummary } from "./trial-store-analysis.js";

/** Where the cost of a trial comes from. `settled`: the trial's store
 *  analysis, or its published store whose SHA-256 equals the run summary's.
 *  `snapshot`: the published store without that identity, which is the last
 *  evidence snapshot of a trial that Harbor stopped at its agent timeout.
 *  `unavailable`: the trial published neither. */
export type CostBasis = "settled" | "snapshot" | "unavailable";

/** The cost of one trial: the usage summary of its evidence, and none when the trial has no evidence. */
export type TrialCost = { readonly basis: "settled" | "snapshot"; readonly usage: UsageSummary } | { readonly basis: "unavailable"; readonly usage: null };

/** The estimated cost of a set of trials, with the count of trials at each
 *  basis. It is a lower bound when any trial is priced from a snapshot or has
 *  no evidence, or when a trial's usage summary has an entry that it could not
 *  price. */
export interface CostTotal {
  readonly estimatedUsd: number;
  readonly lowerBound: boolean;
  readonly settled: number;
  readonly snapshots: number;
  readonly unavailable: number;
  /** Trials with an unmeasured, unpriced, or undecoded usage entry. */
  readonly incompleteUsage: number;
}

/** The store that the shim publishes into a trial's agent logs: the settled store, or the last snapshot of a running trial. */
const PUBLISHED_STORE = join("agent", "flywheel-evidence", ".flywheel", "flywheel.sqlite");

/** The decoded file, or undefined when it does not exist or does not decode. */
async function decodedFile<T>(path: string, decode: (value: unknown) => T): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  try {
    return decode(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function evidenceSha256(summary: unknown): string {
  const value = typeof summary === "object" && summary !== null && "evidence_sha256" in summary ? summary.evidence_sha256 : undefined;
  if (typeof value !== "string") throw new Error("run summary names no evidence digest");
  return value;
}

/** The usage summary of a store image. The image is deserialized in memory,
 *  so the file is never opened with SQLite and no journal or sidecar is
 *  written beside it. */
function storeUsage(bytes: Buffer): UsageSummary {
  // The snapshot copy of rounds recorded before it claimed rollback journaling
  // left the WAL file format (2) in header bytes 18 and 19, and SQLite cannot
  // read such an image from memory. Remove this when no round recorded before
  // 2026-11-10 is scored again.
  if (bytes[18] === 2 || bytes[19] === 2) { bytes[18] = 1; bytes[19] = 1; }
  const db = Database.deserialize(bytes, true);
  try {
    return usageSummary(createSqliteEventReadSurface(db));
  } finally {
    db.close();
  }
}

/** Prices one trial from its directory, or, for a trial whose directory the
 *  run did not download, records it as unavailable. It takes the usage
 *  summary of the trial's store analysis when that decodes at the current
 *  version; otherwise it prices the published store. Throws when a present
 *  file cannot be read or the published store is not a SQLite image. */
export async function trialCost(directory: string | undefined): Promise<TrialCost> {
  if (directory === undefined) return { basis: "unavailable", usage: null };
  const analysis = await decodedFile(join(directory, "agent", TRIAL_STORE_ANALYSIS_NAME), decodeTrialStoreAnalysis);
  if (analysis !== undefined) return { basis: "settled", usage: analysis.usage };
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, PUBLISHED_STORE));
  } catch (error) {
    if (isMissingFile(error)) return { basis: "unavailable", usage: null };
    throw error;
  }
  const settled = await decodedFile(join(directory, "agent", "flywheel-run-summary.json"), evidenceSha256) === createHash("sha256").update(bytes).digest("hex");
  return { basis: settled ? "settled" : "snapshot", usage: storeUsage(bytes) };
}

/** Whether the trial's usage has an entry that its cost does not price. */
function incompleteUsage(cost: TrialCost): boolean {
  return cost.usage !== null && cost.usage.unmeasured + cost.usage.unpriced + cost.usage.undecoded > 0;
}

/** Sums the trial costs. A trial without evidence adds no amount; it makes the total a lower bound. */
export function costTotal(costs: readonly TrialCost[]): CostTotal {
  const count = (basis: CostBasis): number => costs.filter((cost) => cost.basis === basis).length;
  const settled = count("settled"), incomplete = costs.filter(incompleteUsage).length;
  return {
    estimatedUsd: costs.reduce((sum, cost) => cost.usage === null ? sum : sum + cost.usage.estimatedUsd, 0),
    lowerBound: settled < costs.length || incomplete > 0,
    settled,
    snapshots: count("snapshot"),
    unavailable: count("unavailable"),
    incompleteUsage: incomplete,
  };
}
