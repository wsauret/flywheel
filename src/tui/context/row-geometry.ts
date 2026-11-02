import { type Accessor, createContext, useContext } from "solid-js"

// A transcript row records its height once, and the eager measure pass counts that record as
// the row's final geometry. Content that loads its own shape after mounting (mutation evidence
// metadata) would be recorded at its interim height, and the row would unmount before its real
// height arrives. Such content holds the row's measurement until its geometry is settled.
export interface RowGeometryChannel {
  /** Hold the row's height record while `settled` is false. The hold ends with its owner. */
  readonly hold: (settled: Accessor<boolean>) => void
}

const RowGeometryContext = createContext<RowGeometryChannel>({ hold: () => {} })

export const RowGeometryProvider = RowGeometryContext.Provider

export function useRowGeometry(): RowGeometryChannel {
  return useContext(RowGeometryContext)
}
