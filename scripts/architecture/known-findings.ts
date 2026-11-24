// Matches findings against the reviewed list of known findings
// (scripts/architecture-allowlist.ts).
import type { Finding, LintName } from "./graph.ts";

// One reviewed finding: debt that has a named cheapest fix, or a seam that
// the design intends. `key` is the finding's key at review time.
export interface KnownFinding {
  lint: LintName;
  key: string;
  reason: string;
}

export interface Reconciliation {
  // Findings that no entry names: new structural problems.
  unknown: Finding[];
  // Entries that name no current finding: the problem is gone, or its key moved.
  stale: KnownFinding[];
}

// An entry names one finding by its lint and its whole key. For a circle the
// key is every member, so a circle that grows, shrinks, splits, or is replaced
// is a new finding, and its old entry is stale until the list is reviewed.
const matches = (entry: KnownFinding, finding: Finding): boolean => entry.lint === finding.lint && entry.key === finding.key;

export function reconcile(findings: readonly Finding[], known: readonly KnownFinding[]): Reconciliation {
  return {
    unknown: findings.filter((finding) => !known.some((entry) => matches(entry, finding))),
    stale: known.filter((entry) => !findings.some((finding) => matches(entry, finding))),
  };
}
