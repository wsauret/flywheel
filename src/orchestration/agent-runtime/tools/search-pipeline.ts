/**
 * Pure selection pipeline for content search: group by file, rank files before
 * pagination, distribute round-robin (tier-aware), and trim to a char budget.
 *
 * Every stage takes input and returns NEW values; no stage mutates a shared
 * GrepMatch. The renderer lives only in search.ts and is never
 * imported here - trimToBudget estimates char counts in-stage (the rough
 * cap grain of fff, MIT; credited in THIRD-PARTY-NOTICES.md), so the pipeline stays renderer-independent and one-way.
 */

import type { GrepMatch } from "./ripgrep.js";
import { pathWeight, tierForMatch } from "./search-ranking.js";
import type { RankedMatch, RankOptions, RankTier } from "./search-ranking.js";

export interface FileGroups {
  readonly fileOrder: readonly string[];
  readonly byFile: ReadonlyMap<string, readonly GrepMatch[]>;
}

export interface WindowSelection {
  readonly windowMatches: readonly GrepMatch[];
  readonly fileLimitReached: boolean;
  readonly skipFiles: number;
  readonly windowFileCount: number;
  readonly totalFiles: number;
}

/** Group matches by path, preserving first-seen file order. New arrays; inputs
 *  untouched. */
export function groupByFile(matches: readonly GrepMatch[]): FileGroups {
  const fileOrder: string[] = [];
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const arr = byFile.get(m.path);
    if (arr) {
      arr.push(m);
    } else {
      fileOrder.push(m.path);
      byFile.set(m.path, [m]);
    }
  }
  return { fileOrder, byFile };
}

/** Slice the file window for pagination; collect the matches for the windowed
 *  files into a NEW array. */
export function selectWindow(groups: FileGroups, skip: number, fileLimit: number): WindowSelection {
  const totalFiles = groups.fileOrder.length;
  const skipFiles = Math.min(skip, totalFiles);
  const windowFiles = groups.fileOrder.slice(skipFiles, skipFiles + fileLimit);
  const fileLimitReached = totalFiles > skipFiles + fileLimit;

  const windowMatches: GrepMatch[] = [];
  for (const file of windowFiles) {
    const fileMatches = groups.byFile.get(file);
    if (fileMatches) for (const m of fileMatches) windowMatches.push(m);
  }
  return { windowMatches, fileLimitReached, skipFiles, windowFileCount: windowFiles.length, totalFiles };
}


function bestFileTier(matches: readonly GrepMatch[]): RankTier {
  let best: RankTier = 2;
  for (const match of matches) {
    const tier = tierForMatch(match);
    if (tier < best) best = tier;
    if (best === 0) break;
  }
  return best;
}

export function rankFileGroups(groups: FileGroups, opts: RankOptions): FileGroups {
  if (!opts.rankingEnabled) return groups;

  const fileOrder = groups.fileOrder
    .map((file, index) => ({
      file,
      index,
      tier: bestFileTier(groups.byFile.get(file) ?? []),
    }))
    .sort((a, b) =>
      a.tier - b.tier ||
      pathWeight(a.file, opts.preferTests) - pathWeight(b.file, opts.preferTests) ||
      a.index - b.index)
    .map(({ file }) => file);

  return { fileOrder, byFile: groups.byFile };
}

const TIER_ORDER: readonly RankTier[] = [0, 1, 2];

/** Round-robin one tier's matches across the files they belong to, appending
 *  to `out` until `limit` is reached. Preserves the relocated round-robin's
 *  per-file fairness within a single tier. */
function distributeTier(tierMatches: readonly RankedMatch[], out: RankedMatch[], limit: number): void {
  const byFile = new Map<string, RankedMatch[]>();
  for (const m of tierMatches) {
    const arr = byFile.get(m.match.path);
    if (arr) arr.push(m);
    else byFile.set(m.match.path, [m]);
  }
  const iterators = [...byFile.values()].map((arr) => ({ arr, idx: 0 }));
  while (out.length < limit) {
    let added = false;
    for (const it of iterators) {
      if (out.length >= limit) break;
      if (it.idx < it.arr.length) {
        // SAFETY: the enclosing `it.idx < it.arr.length` guard proves the element is present.
        out.push(it.arr[it.idx]!);
        it.idx++;
        added = true;
      }
    }
    if (!added) break;
  }
}

/** Distribute evenly across files so one large file can't dominate - TIER-AWARE.
 *  Round-robins ACROSS FILES WITHIN EACH TIER: emit tier-0 (definitions)
 *  round-robined across files first, then tier-1 (usages), then tier-2
 *  (imports). Definitions-first stays GLOBAL while per-file fairness holds
 *  WITHIN a tier. Relocated from search.ts round-robin; now consumes
 *  and returns RankedMatch. */
export function distributeRoundRobin(ranked: readonly RankedMatch[], limit: number): RankedMatch[] {
  // Early path returns a COPY (already tier-sorted by rankMatches) so the stage
  // is uniformly non-aliasing.
  if (ranked.length <= limit) return [...ranked];

  const out: RankedMatch[] = [];
  for (const tier of TIER_ORDER) {
    if (out.length >= limit) break;
    distributeTier(ranked.filter((r) => r.tier === tier), out, limit);
  }
  return out;
}

/** fff char budget: smaller windows get a larger per-window allowance.
 *  (fff output.rs:209-215; drops fff's Usage arm - no Flywheel analogue.) */
export function maxOutputChars(uniqueFiles: number): number {
  return uniqueFiles <= 3 ? 5000 : uniqueFiles <= 8 ? 3500 : 2500;
}

// Rough per-group framing: " <line>: " prefix + file-header amortization,
// fff-style rough cap (not exact render fidelity).
const PER_MATCH_OVERHEAD = 8;

/** Estimate the rendered char count of one match-group (the match line plus
 *  its own context lines) WITHOUT calling the renderer. Sum of line lengths +
 *  a small constant per match. ROUGH cap (fff's grain). */
function estimateGroupChars(match: GrepMatch): number {
  let n = match.line.length + PER_MATCH_OVERHEAD;
  for (const ctx of match.contextBefore ?? []) n += ctx.line.length + 1;
  for (const ctx of match.contextAfter ?? []) n += ctx.line.length + 1;
  return n;
}

/** Trim selected matches so the estimated rendered window stays within the char
 *  budget, never splitting a numbered content line (applied at the match-group
 *  boundary). Pure and renderer-INDEPENDENT - does NOT call renderMatchLines.
 *  Returns a NEW, possibly-shorter array. Always returns at least one group
 *  when the first group alone exceeds the budget (the `shown > 0` rule from
 *  fff output.rs:357). */
export function trimToBudget(selected: readonly RankedMatch[], budget: number): RankedMatch[] {
  const out: RankedMatch[] = [];
  let charCount = 0;
  for (const r of selected) {
    const groupLen = estimateGroupChars(r.match);
    if (charCount + groupLen > budget && out.length > 0) break;
    charCount += groupLen;
    out.push(r);
  }
  return out;
}
