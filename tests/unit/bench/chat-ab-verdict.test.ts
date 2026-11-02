import { describe, expect, it } from "bun:test";
import type { TestOutcome } from "../../../bench/chat-ab/acceptance.js";
import { baselineInSlotA, DEFAULT_RULE, decide, pairOutcome, sideOf } from "../../../bench/chat-ab/verdict.js";

function acceptance(fix: TestOutcome, guard: TestOutcome = "pass") {
  return { failToPass: { fix }, passToPass: { guard } };
}

const preserved = [{ caseId: "task/r0", baseline: acceptance("pass"), candidate: acceptance("pass") }];

describe("chat A/B verdict", () => {
  it("swaps the slots between the two orders of every pair", () => {
    for (const task of ["auth-sibling-lost", "cut-tool-args"]) {
      for (const repeat of [0, 1]) expect(baselineInSlotA(task, repeat, 0)).toBe(!baselineInSlotA(task, repeat, 1));
    }
  });

  it("maps a slot winner to the side that held the slot", () => {
    expect(sideOf("A", true)).toBe("baseline");
    expect(sideOf("A", false)).toBe("candidate");
    expect(sideOf("B", true)).toBe("candidate");
    expect(sideOf("tie", false)).toBe("tie");
  });

  it("counts a pair as a win only when both orders name the same side", () => {
    expect(pairOutcome(["candidate", "candidate"])).toBe("candidate");
    // A judge that prefers slot A in both orders names each side once.
    expect(pairOutcome([sideOf("A", true), sideOf("A", false)])).toBe("tie");
    expect(pairOutcome(["baseline", "tie"])).toBe("tie");
  });

  it("adopts only at the win ratio and under the cost limit", () => {
    expect(decide({ candidate: 8, baseline: 4 }, 0.1, DEFAULT_RULE, preserved).adopt).toBe(true);
    expect(decide({ candidate: 7, baseline: 4 }, 0.1, DEFAULT_RULE, preserved).adopt).toBe(false);
    expect(decide({ candidate: 8, baseline: 4 }, 0.31, DEFAULT_RULE, preserved).reasons).toEqual(["mean cost per cell rose 31%, above the 30% limit"]);
    // The 2026-10-05 second-review-seat run: 5 wins against 9 at 20% more cost.
    expect(decide({ candidate: 5, baseline: 9 }, 0.2, DEFAULT_RULE, preserved)).toEqual({ adopt: false, reasons: ["the candidate won 5 pairs and needed 18 (2x the baseline's 9)"] });
  });

  it("never adopts when no pair can measure the cost rise", () => {
    expect(decide({ candidate: 8, baseline: 0 }, null, DEFAULT_RULE, preserved)).toEqual({ adopt: false, reasons: ["paired cost evidence is unavailable, so the cost rise is unknown"] });
  });

  it("refuses a rule that cannot be compared", () => {
    expect(() => decide({ candidate: 1, baseline: 0 }, 0, { minWinRatio: Number("2x"), maxCostIncrease: 0.3 }, preserved)).toThrow("Invalid decision rule");
  });

  it("never adopts a candidate that won no pair", () => {
    expect(decide({ candidate: 0, baseline: 0 }, 0, DEFAULT_RULE, preserved).adopt).toBe(false);
    expect(decide({ candidate: 1, baseline: 0 }, 0, DEFAULT_RULE, preserved).adopt).toBe(true);
  });

  it("rejects a judge-preferred candidate that breaks a frozen guard", () => {
    const comparisons = [{ caseId: "task/r0", baseline: acceptance("pass"), candidate: acceptance("pass", "fail") }];
    expect(decide({ candidate: 8, baseline: 0 }, 0, DEFAULT_RULE, comparisons)).toEqual({
      adopt: false,
      reasons: ["task/r0: candidate broke frozen guards: guard"],
    });
  });

  it("rejects a lost fix even when another case improves", () => {
    const comparisons = [
      { caseId: "task/r0", baseline: acceptance("pass"), candidate: acceptance("fail") },
      { caseId: "task/r1", baseline: acceptance("fail"), candidate: acceptance("pass") },
    ];
    expect(decide({ candidate: 8, baseline: 0 }, 0, DEFAULT_RULE, comparisons)).toEqual({
      adopt: false,
      reasons: ["task/r0: candidate regressed passing fixes: fix"],
    });
  });

  it("allows improved or unchanged incomplete fixes when no guard breaks", () => {
    const comparisons = [
      { caseId: "task/r0", baseline: acceptance("fail"), candidate: acceptance("pass") },
      { caseId: "task/r1", baseline: acceptance("fail"), candidate: acceptance("fail") },
    ];
    expect(decide({ candidate: 8, baseline: 0 }, 0, DEFAULT_RULE, comparisons).adopt).toBe(true);
  });
});
