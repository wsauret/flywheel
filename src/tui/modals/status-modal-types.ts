import type { ModuleRowAction } from "../../protocol/protocol-module.js"

/** One row of the status modal. */
export interface StatusRow {
  label: string
  value: string
  /** Clipboard payload when the row is highlighted; defaults to value. */
  copy?: string
  hint?: string
  tone?: "warning"
  /** Enter and a click run this instead of copying the row. */
  action?: ModuleRowAction
}
