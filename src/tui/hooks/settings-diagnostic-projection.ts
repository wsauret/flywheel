import { type Accessor, createSignal } from "solid-js"
import { settingRowId } from "../../orchestration/config/setting-definitions.js"
import { configProblemText } from "../../protocol/client/config-problem-copy.js"
import type { RuntimeConfigDiagnostic, RuntimeConfigStatusView } from "../../protocol/runtime-config-protocol-types.js"
import type { SettingsRow } from "./settings-modal-types.js"

/** Marks the row whose authored value has a configuration problem, with
 *  what the problem means for the value in force. */
export function annotateConfigDiagnostic(
  row: SettingsRow,
  diagnostics: readonly RuntimeConfigDiagnostic[],
  status: RuntimeConfigStatusView,
): SettingsRow {
  if (row.kind === "separator") return row
  const diagnostic = diagnostics.find((candidate) => settingRowId({ id: candidate.settingId }) === row.id)
  return diagnostic === undefined ? row : { ...row, warning: configProblemText(diagnostic.reason, status) }
}

/** The reason a group carries for the setting inside it. */
const GROUP_PROBLEM = "A setting in this group has a configuration problem."

function groupContainsDiagnostic(row: SettingsRow, diagnosticRowIds: ReadonlySet<string>): boolean {
  if (row.kind === "separator") return false
  if (diagnosticRowIds.has(row.id)) return true
  return (row.kind === "group" || row.kind === "disclosure") && row.rows().some((child) => groupContainsDiagnostic(child, diagnosticRowIds))
}

export function annotateConfigDiagnosticGroup(
  row: SettingsRow,
  diagnostics: readonly RuntimeConfigDiagnostic[],
): SettingsRow {
  if (row.kind !== "group" && row.kind !== "disclosure") return row
  const diagnosticRowIds = new Set(diagnostics.map((diagnostic) => settingRowId({ id: diagnostic.settingId })))
  if (!row.rows().some((child) => groupContainsDiagnostic(child, diagnosticRowIds))) return row
  return { ...row, warning: GROUP_PROBLEM }
}

interface WriteRefusal { readonly revision: number | undefined; readonly message: string }

/** The writes the runtime refused, one for each row. A refusal holds only for
 *  the configuration revision it was refused at: the next publication, from a
 *  later save here or a repair of the file elsewhere, retires it. So the row
 *  keeps a mark after the error toast leaves, until the person acts. */
export function createWriteRefusals(revision: Accessor<number | undefined>) {
  const [refusals, setRefusals] = createSignal<ReadonlyMap<string, WriteRefusal>>(new Map())
  return {
    record(rowId: string, message: string): void {
      setRefusals((current) => new Map(current).set(rowId, { revision: revision(), message: `Not saved: ${message}` }))
    },
    annotate(row: SettingsRow): SettingsRow {
      if (row.kind === "separator") return row
      const refusal = refusals().get(row.id)
      return refusal === undefined || refusal.revision !== revision() ? row : { ...row, warning: refusal.message }
    },
  }
}
