import { SHORT_TITLE_MAX_CHARS, type SessionTitlePatch } from "../../../protocol/runtime/app-service-types.js"

/** Normalize a user edit without reading or replacing its unchanged counterpart. Refuse empty edits and blank supplied names. */
export function editedSessionLabels(patch: SessionTitlePatch): { label?: string; shortLabel?: string } | null {
  const title = patch.title?.trim()
  const shortTitle = patch.shortTitle?.trim().slice(0, SHORT_TITLE_MAX_CHARS)
  if ((title === undefined && shortTitle === undefined) || title === "" || shortTitle === "") return null
  return { ...(title !== undefined ? { label: title } : {}), ...(shortTitle !== undefined ? { shortLabel: shortTitle } : {}) }
}
