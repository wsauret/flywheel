import { Icon, ICONS } from "./icons.js"
import { returnToLatestLabel } from "../../../src/protocol/client/return-to-latest.js"

export interface ReturnToLatestProps {
  readonly unseen: number
  readonly onClick: () => void
}

/** Returns a reader to the live transcript tail and names unseen messages. */
export function ReturnToLatest(props: ReturnToLatestProps) {
  const visibleLabel = () => returnToLatestLabel(props.unseen)
  const accessibleLabel = () => props.unseen === 0
    ? "Jump to latest"
    : `${visibleLabel()}. Jump to latest`

  return (
    <button class="jump-latest" onClick={props.onClick} aria-label={accessibleLabel()} title={accessibleLabel()}>
      <span>{visibleLabel()}</span>
      <Icon path={ICONS.arrowDown} size={18} />
    </button>
  )
}
