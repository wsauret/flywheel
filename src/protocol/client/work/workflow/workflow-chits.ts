/**
 * The chits of a workflow's progress: one function draws the plan bar of
 * the card and the chits of each phase, in every client. A filled `▰` stands
 * for a unit that finished well, failed, runs, or that an interrupt holds,
 * each in the colour of its state, and an empty `▱` for a unit that has not
 * started. The exact count always follows the chits.
 */

import type { WorkflowOutline } from "./workflow-outline.js"

export type WorkflowChitTone = "done" | "failed" | "running" | "parked" | "pending"

/** Units by where they stand. `done` counts only work that finished
 *  without a failure, so the five counts never overlap. */
export interface WorkflowUnitCounts {
  readonly done: number
  readonly failed: number
  readonly running: number
  readonly parked: number
  readonly total: number
}

/** How many chits a plan bar and the chits of one phase hold on each
 *  surface. A terminal inline card picks its row by its box width, and the
 *  web client by the width of its column. */
export const CHIT_SLOTS = {
  /** A terminal inline card whose box is 80 columns or wider. */
  terminalWide: { plan: 30, phase: 12 },
  /** A terminal inline card whose box is narrower than 80 columns. */
  terminalNarrow: { plan: 20, phase: 8 },
  /** A terminal card below 46 columns, which draws no box. */
  terminalCompact: { plan: 12, phase: 6 },
  /** The terminal's full-size card. */
  terminalFull: { plan: 40, phase: 12 },
  /** The desktop web client, at both sizes. */
  web: { plan: 40, phase: 12 },
  /** A phone, at both sizes. */
  phone: { plan: 20, phase: 8 },
  /** The agent view's workflow band on a phone, where the plan's chits
   *  share one line with the word `workflow` and the count. */
  phoneBand: { plan: 12 },
} as const

/** The units of an outline by where they stand, one for each agent. A
 *  list's failed agents finished, so they count as failed and not as done. */
export function workflowUnitCounts(outline: WorkflowOutline): WorkflowUnitCounts {
  const agents = outline.phases.flatMap(({ agents: phaseAgents }) => phaseAgents)
  const finishedFailed = outline.phases.reduce((sum, { form, failed }) => sum + (form === "list" ? failed : 0), 0)
  return {
    done: Math.max(0, outline.progress.done - finishedFailed),
    failed: outline.progress.failed,
    running: agents.filter(({ state }) => state === "running").length,
    parked: agents.filter(({ state }) => state === "parked").length,
    total: outline.progress.total,
  }
}

interface Group {
  readonly tone: WorkflowChitTone
  readonly count: number
  /** The group's exact share of the slots. */
  readonly share: number
  chits: number
}

/** The chits of `counts` in `slots`, grouped by state in the order done,
 *  failed, running, parked, pending, so the empty chits always read as the
 *  work left. While the units fit, each unit is one chit. Above `slots`, the
 *  bar holds exactly `slots` chits in proportion: each state with a unit
 *  holds at least one, the chits left over go to the states whose exact
 *  share exceeds what they hold by the most, and when the minimum of one
 *  overspends the bar, the largest group gives chits back. */
export function workflowChits(counts: WorkflowUnitCounts, slots: number): readonly { readonly tone: WorkflowChitTone; readonly chits: number }[] {
  const total = Math.max(counts.total, counts.done + counts.failed + counts.running + counts.parked)
  const pending = total - counts.done - counts.failed - counts.running - counts.parked
  const tones = ([["done", counts.done], ["failed", counts.failed], ["running", counts.running], ["parked", counts.parked], ["pending", pending]] as const)
    .filter(([, count]) => count > 0)
  if (total <= slots) return tones.map(([tone, count]) => ({ tone, chits: count }))
  const groups: Group[] = tones.map(([tone, count]) => ({ tone, count, share: (count / total) * slots, chits: Math.max(1, Math.floor((count / total) * slots)) }))
  let spare = slots - groups.reduce((sum, { chits }) => sum + chits, 0)
  while (spare < 0) {
    const largest = groups.reduce((best, group) => group.chits > best.chits ? group : best)
    largest.chits -= 1
    spare += 1
  }
  const lacking = groups.toSorted((a, b) => (b.share - b.chits) - (a.share - a.chits))
  for (let next = 0; spare > 0; next += 1) {
    // SAFETY: A bar above its slots holds at least one group.
    lacking[next % lacking.length]!.chits += 1
    spare -= 1
  }
  return groups.flatMap(({ tone, chits }) => chits > 0 ? [{ tone, chits }] : [])
}

/** The terminal glyph of a chit: filled for work that started, empty for
 *  work that has not. */
export function workflowChitGlyph(tone: WorkflowChitTone): string {
  return tone === "pending" ? "▱" : "▰"
}
