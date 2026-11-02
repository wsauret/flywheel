import { describe, expect, it } from "bun:test";

import type { GrepMatch } from "../../../../../src/orchestration/agent-runtime/tools/ripgrep.js";
import {
  distributeRoundRobin,
  trimToBudget,
} from "../../../../../src/orchestration/agent-runtime/tools/search-pipeline.js";
import type { RankedMatch, RankTier } from "../../../../../src/orchestration/agent-runtime/tools/search-ranking.js";

function match(path: string, lineNumber: number, line: string): GrepMatch {
  return { path, lineNumber, line };
}

function ranked(path: string, line: string, tier: RankTier): RankedMatch {
  return { match: match(path, 1, line), isDefinition: tier === 0, tier };
}

describe("distributeRoundRobin", () => {
  it("distributes evenly so one large file cannot dominate", () => {
    const input: RankedMatch[] = [
      ranked("big.ts", "a", 1),
      ranked("big.ts", "b", 1),
      ranked("big.ts", "c", 1),
      ranked("small.ts", "d", 1),
    ];
    const out = distributeRoundRobin(input, 2);
    expect(out.map((r) => r.match.path)).toEqual(["big.ts", "small.ts"]);
  });

  it("is tier-aware: definitions globally precede usages with per-file fairness", () => {
    // File A is definition-heavy; files B and C also hold definitions plus a usage.
    const input: RankedMatch[] = [
      ranked("A.ts", "defA1", 0),
      ranked("A.ts", "defA2", 0),
      ranked("A.ts", "defA3", 0),
      ranked("B.ts", "defB1", 0),
      ranked("C.ts", "defC1", 0),
      ranked("B.ts", "useB", 1),
      ranked("C.ts", "useC", 1),
    ];
    // limit < input length forces distribution (the <= limit early path is a copy).
    const out = distributeRoundRobin(input, 6);
    const lines = out.map((r) => r.match.line);

    // (i) all tier-0 matches precede any tier-1 match.
    const firstUsage = lines.findIndex((l) => l.startsWith("use"));
    const lastDef = lines.map((l) => l.startsWith("def")).lastIndexOf(true);
    expect(lastDef).toBeLessThan(firstUsage);

    // (ii) within the definition prefix, A does not monopolize the first rounds:
    // B's and C's definitions appear before A's later (2nd/3rd) definitions.
    const idxA2 = lines.indexOf("defA2");
    const idxB1 = lines.indexOf("defB1");
    const idxC1 = lines.indexOf("defC1");
    expect(idxB1).toBeLessThan(idxA2);
    expect(idxC1).toBeLessThan(idxA2);
  });
});

describe("trimToBudget", () => {
  it("stops at the budget at a match-group boundary and shortens the array", () => {
    const line = "x".repeat(100); // ~108 estimated chars per group with overhead
    const input: RankedMatch[] = [
      ranked("a.ts", line, 1),
      ranked("a.ts", line, 1),
      ranked("a.ts", line, 1),
    ];
    const out = trimToBudget(input, 150);
    // Only the first group fits (108 <= 150; 216 > 150).
    expect(out.length).toBe(1);
    expect(out[0]?.match.line).toBe(line);
  });

  it("always returns at least one group when the first exceeds the budget", () => {
    const huge = "y".repeat(10000);
    const input: RankedMatch[] = [ranked("a.ts", huge, 1)];
    const out = trimToBudget(input, 100);
    expect(out.length).toBe(1);
  });

});
