import { type Accessor, createContext, useContext } from "solid-js"

// The width of one full-width transcript row, known BEFORE any block mounts.
// Blocks that wrap their own content in JS (tool lists) need their available
// columns at first render; discovering it per block through a post-mount
// resize event renders a blank line that re-wraps a frame later - the
// transient the scroll pipeline then mis-records as a real height. One
// always-mounted element (the viewport's top spacer) reports the shared value;
// every block derives its own width as rowWidth minus its declared chrome,
// with its element measurement as the drift-healing authority
// (see createMeasuredWidth).
export interface RowWidthChannel {
  /** Columns of a full-width transcript row; 0 until first layout. */
  readonly width: Accessor<number>
  /** Report a freshly laid-out row width (the provider's signal dedups). */
  readonly report: (columns: number) => void
}

const defaultChannel: RowWidthChannel = { width: () => 0, report: () => {} }

const RowWidthContext = createContext<RowWidthChannel>(defaultChannel)

export const RowWidthProvider = RowWidthContext.Provider

export function useRowWidth(): RowWidthChannel {
  return useContext(RowWidthContext)
}
