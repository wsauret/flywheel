/** Scoring rules for compare.ts. Each pair is judged twice with the slots
 *  swapped, because a judge tends to prefer whichever change it reads first. */
import { scoreAcceptance, type AcceptanceRecord } from "./acceptance.js";

export type PairSide = "baseline" | "candidate";
export type SlotWinner = "A" | "B" | "tie";

/** True when the baseline's change holds slot A. Order 1 always swaps order 0,
 *  and order 0 alternates across tasks and repeats so neither side always
 *  reads first. */
export function baselineInSlotA(task: string, repeat: number, order: 0 | 1): boolean {
  return (task.length + repeat + order) % 2 === 0;
}

/** The side a single judged order prefers. */
export function sideOf(winner: SlotWinner, baselineFirst: boolean): PairSide | "tie" {
  if (winner === "tie") return "tie";
  return (winner === "A") === baselineFirst ? "baseline" : "candidate";
}

/** A side wins the pair only when both orders name it; any disagreement,
 *  including one tie, makes the pair a tie. */
export function pairOutcome(orders: readonly [PairSide | "tie", PairSide | "tie"]): PairSide | "tie" {
  return orders[0] === orders[1] ? orders[0] : "tie";
}

export interface DecisionRule {
  /** Candidate wins required per baseline win, among pairs that are not ties. */
  readonly minWinRatio: number;
  /** Largest accepted rise in mean cost per cell, as a fraction (0.3 is 30%). */
  readonly maxCostIncrease: number;
}

export const DEFAULT_RULE: DecisionRule = { minWinRatio: 2, maxCostIncrease: 0.3 };

export interface Decision {
  readonly adopt: boolean;
  readonly reasons: readonly string[];
}

export interface AcceptanceComparison {
  readonly caseId: string;
  readonly baseline: AcceptanceRecord;
  readonly candidate: AcceptanceRecord;
}

/** Applies the rule fixed before the run. A candidate with no win never
 *  adopts, and a baseline with no win needs only one candidate win. A cost
 *  rise that no priced pair can measure (`null`) never adopts either.
 *  Frozen guard failures and lost passing fixes veto judge preference. */
export function decide(tally: { readonly candidate: number; readonly baseline: number }, costIncrease: number | null, rule: DecisionRule, acceptance: readonly AcceptanceComparison[]): Decision {
  if (!(rule.minWinRatio > 0) || !(rule.maxCostIncrease >= 0)) throw new Error(`Invalid decision rule: ${JSON.stringify(rule)}`);
  const reasons: string[] = [];
  const winsNeeded = Math.max(1, Math.ceil(tally.baseline * rule.minWinRatio));
  if (tally.candidate < winsNeeded) reasons.push(`the candidate won ${tally.candidate} pairs and needed ${winsNeeded} (${rule.minWinRatio}x the baseline's ${tally.baseline})`);
  if (costIncrease === null) reasons.push("paired cost evidence is unavailable, so the cost rise is unknown");
  else if (costIncrease > rule.maxCostIncrease) reasons.push(`mean cost per cell rose ${Math.round(costIncrease * 100)}%, above the ${Math.round(rule.maxCostIncrease * 100)}% limit`);
  for (const pair of acceptance) {
    const brokenGuards = scoreAcceptance(pair.candidate).brokenGuards;
    if (brokenGuards.length > 0) reasons.push(`${pair.caseId}: candidate broke frozen guards: ${brokenGuards.join(", ")}`);
    const lostFixes = Object.entries(pair.baseline.failToPass).flatMap(([id, outcome]) => outcome === "pass" && pair.candidate.failToPass[id] === "fail" ? [id] : []);
    if (lostFixes.length > 0) reasons.push(`${pair.caseId}: candidate regressed passing fixes: ${lostFixes.join(", ")}`);
  }
  return { adopt: reasons.length === 0, reasons };
}
