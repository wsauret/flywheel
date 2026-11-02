import { SHORT_TITLE_MAX_CHARS, type SessionTitlePatch } from "../../protocol/app-service-types.js"

/** Derive the compact tab label while preserving a user-chosen full name. */
export function titlesFromName(name: string) {
  return { full: name, short: name.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, SHORT_TITLE_MAX_CHARS) }
}

/** Normalize a user edit without reading or replacing its unchanged counterpart. Refuse empty edits and blank supplied names. */
export function editedSessionLabels(patch: SessionTitlePatch): { label?: string; shortLabel?: string } | null {
  const title = patch.title?.trim()
  const shortTitle = patch.shortTitle?.trim().slice(0, SHORT_TITLE_MAX_CHARS)
  if ((title === undefined && shortTitle === undefined) || title === "" || shortTitle === "") return null
  return { ...(title !== undefined ? { label: title } : {}), ...(shortTitle !== undefined ? { shortLabel: shortTitle } : {}) }
}
