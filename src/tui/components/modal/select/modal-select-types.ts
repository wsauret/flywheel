import type { RGBA } from "@opentui/core"

export interface ModalSelectOption<T = string> {
  id: string
  title: string
  value: T
  description?: string
  footer?: string
  category?: string
  disabled?: boolean
  disabledReason?: string
  bg?: RGBA
  statusIcon?: string
  statusColor?: RGBA
  rightDetail?: string
}

export interface Action<T = string> {
  key: string
  label: string
  onTrigger: (option: ModalSelectOption<T>) => void
}

export type FlatRow<T = string> =
  | { kind: "option"; id: string; rowIndex: number; option: ModalSelectOption<T> }
  | { kind: "category"; id: string; rowIndex: number; categoryLabel: string }

export interface FilteredResult<T = string> {
  rows: readonly FlatRow<T>[]
  totalMatches: number
  capped: boolean
}

