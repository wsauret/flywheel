export interface UnseenMessageState {
  readonly baseline: number
  readonly unseen: number
}

/** Derive unseen messages from one absolute baseline, rebasing after truncation. */
export function unseenMessageCount(baseline: number, visibleMessageCount: number): UnseenMessageState {
  const nextBaseline = Math.min(baseline, visibleMessageCount)
  return { baseline: nextBaseline, unseen: Math.max(0, visibleMessageCount - nextBaseline) }
}

export function returnToLatestLabel(unseen: number): string {
  if (unseen === 0) return "Latest"
  return `${unseen} new message${unseen === 1 ? "" : "s"}`
}
