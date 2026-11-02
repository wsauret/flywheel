import type { EffortOptionRow, ModelAssignmentRow, ModelOptionRow, ModelSelectionSlot } from "../../protocol/model-assignment-protocol-types.js"
import { type FixedBriefFields, parseBriefRoleId, briefFixedRoleId, briefRoleId } from "../../protocol/brief-role-id.js"
import type { RoleSettingEntry, RoleAssignmentSnapshot } from "../session/schemas.js"
import { normalizeSelectableModelId } from "./model-compatibility.js"
import { roleSlot } from "./role-selection.js"
import { effectiveRoleAssignments } from "./session-role-resolver.js"
import { activeServingSeat, servingSeatFieldRefusal } from "../../protocol/active-serving-seat.js"

/** The seat of one running agent of a workflow, as a client opens it: its
 *  record seat `brief.<brief id>.at.<definition id>`. A session answers it
 *  from the agent's brief seat, except for each field that the agent
 *  record's workflow file fixed (refer to `briefFixedRoleId`): the model
 *  picker shows that field as the file set it and offers no other value. */
export interface BriefAtSeat {
  readonly brief: ModelSelectionSlot
  /** The record's fixed seat, when its file fixed a field: the seat's id,
   *  the fields it fixes, and the pair that the record's agents run on. */
  readonly fixed?: { readonly roleId: string; readonly fields: FixedBriefFields; readonly pair: RoleSettingEntry }
}

const FIXED_FIELDS = ["both", "model", "effort"] as const satisfies readonly FixedBriefFields[]

/** The record seat that `slot` names, or undefined when it names another
 *  seat. `snapshot` is the session's role snapshot; without one, no field is
 *  fixed. */
export function briefAtSeat(slot: ModelSelectionSlot, snapshot?: RoleAssignmentSnapshot): BriefAtSeat | undefined {
  const selector = parseBriefRoleId(slot.roleId)
  if (selector?.definitionId === undefined) return undefined
  const brief = roleSlot(briefRoleId(selector.briefId))
  const fields = FIXED_FIELDS.find((candidate) => snapshot?.defaults[briefFixedRoleId(selector.briefId, selector.definitionId, candidate)] !== undefined)
  const settings = snapshot === undefined ? {} : effectiveRoleAssignments(snapshot)
  const active = activeServingSeat({ ...selector, fixedFields: fields }, (roleId) => settings[roleId])
  const pair = active.selection
  if (active.fixedFields === undefined || pair === undefined) return { brief }
  return { brief, fixed: { roleId: briefFixedRoleId(selector.briefId, selector.definitionId, active.fixedFields), fields: active.fixedFields, pair } }
}

const fixesEffort = (fields: FixedBriefFields) => fields !== "model"

const sameModel = (left: string, right: string | undefined) => right !== undefined && normalizeSelectableModelId(left) === normalizeSelectableModelId(right)

/** The reason a person's save of `model` and `effort` cannot change an
 *  agent record with a fixed seat, or undefined when it changes only the fields that the
 *  file left to the person. A null model asks to inherit, which would drop
 *  the file's choice. */
export function fixedSaveRefusal(fixed: NonNullable<BriefAtSeat["fixed"]>, model: string | null, effort: string | null | undefined): string | undefined {
  if (model === null) return servingSeatFieldRefusal(fixed.fields, { model: true, effort: true })
  return servingSeatFieldRefusal(fixed.fields, { model: !sameModel(model, fixed.pair.model), effort: effort != null && effort !== fixed.pair.effort })
}

/** The assignment row of a record seat: its brief seat's row, with the
 *  pair that the record's agents run on when its file fixed a field. */
export function briefAtAssignmentRow(row: ModelAssignmentRow, slot: ModelSelectionSlot, seat: BriefAtSeat): ModelAssignmentRow {
  if (seat.fixed === undefined) return { ...row, slot }
  return { ...row, slot, modelSource: "explicit" }
}

/** The model rows of a record seat: its brief seat's rows without an
 *  inherit row, with the record's pair as the current row. A fixed model
 *  offers only itself, and only when the effort is still the person's to
 *  choose; a fixed effort is the only effort that a row offers. */
export function briefAtModelOptions(rows: readonly ModelOptionRow[], slot: ModelSelectionSlot, seat: BriefAtSeat): readonly ModelOptionRow[] {
  const fixed = seat.fixed
  if (fixed === undefined) return rows.map((row) => ({ ...row, slot }))
  const { fields } = fixed
  const selected = rows.find((row) => row.current)
  const selectedModel = selected?.inheritModel ?? selected?.model ?? undefined
  return rows.flatMap((row): ModelOptionRow[] => {
    if (row.inherit === true || row.model === null) return []
    const current = sameModel(row.model, selectedModel)
    const effort = row.effort
    const efforts = fixesEffort(fields) ? [effort] : row.efforts
    const refusal = servingSeatFieldRefusal(fields, { model: !current, effort: false })
    return [{ ...row, slot, current, effort, efforts, selectable: row.selectable && refusal === undefined, ...(refusal === undefined ? {} : { reason: refusal }) }]
  })
}

/** The effort rows of a record seat for `model`: its brief seat's rows
 *  without an inherit row, with the record's effort as the current row. A
 *  fixed effort is the only row that a person can choose. */
export function briefAtEffortOptions(rows: readonly EffortOptionRow[], slot: ModelSelectionSlot, seat: BriefAtSeat, model: string | null): readonly EffortOptionRow[] {
  const fixed = seat.fixed
  if (fixed === undefined) return rows.map((row) => ({ ...row, slot }))
  const { pair, fields } = fixed
  const onPairModel = model !== null && sameModel(model, pair.model)
  return rows.flatMap((row): EffortOptionRow[] => {
    if (row.inherit === true || row.effort === null) return []
    const current = onPairModel && row.effort === pair.effort
    const refusal = servingSeatFieldRefusal(fields, { model: !onPairModel, effort: row.effort !== pair.effort })
    return [{ ...row, slot, current, selectable: row.selectable && refusal === undefined }]
  })
}
