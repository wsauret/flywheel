/** The block range that the transcript viewport mounts, grown toward its goal
 *  one bounded batch per frame. */

interface WidenTowardsInput {
  readonly prev: { readonly start: number; readonly end: number } | undefined
  readonly goal: { readonly start: number; readonly end: number }
  readonly must: { readonly start: number; readonly end: number }
  readonly budget: number
  readonly upFirst: boolean
}

/** One budgeted step from `prev` toward `goal`. Shrinks (edges past the goal)
 *  apply immediately: dropping rows is cheap and keeps residency bounded.
 *  Growth spends at most `budget` new blocks, the edge in the scroll direction
 *  first. The result always covers `must`, whatever the budget - viewport
 *  coverage is never deferred. With no prior range, or after a jump that left
 *  the previous range disjoint from the goal, growth restarts from the
 *  viewport cover itself, so even the first emission spends only one budget
 *  beyond the viewport. */
export function widenTowards(input: WidenTowardsInput): { readonly start: number; readonly end: number } {
  const { goal, must, budget, upFirst } = input
  const cover = (r: { start: number; end: number }) => ({ start: Math.min(r.start, must.start), end: Math.max(r.end, must.end) })
  const prev = input.prev ?? must
  let start = Math.max(prev.start, goal.start)
  let end = Math.min(prev.end, goal.end)
  if (end <= start) {
    // Disjoint jump: restart growth from the viewport cover clamped into the goal.
    start = Math.max(goal.start, Math.min(must.start, goal.end - 1))
    end = Math.min(goal.end, Math.max(must.end, goal.start + 1))
  }
  let remaining = budget
  const growUp = () => {
    const spend = Math.min(remaining, start - goal.start)
    start -= spend
    remaining -= spend
  }
  const growDown = () => {
    const spend = Math.min(remaining, goal.end - end)
    end += spend
    remaining -= spend
  }
  if (upFirst) { growUp(); growDown() } else { growDown(); growUp() }
  return cover({ start, end })
}
