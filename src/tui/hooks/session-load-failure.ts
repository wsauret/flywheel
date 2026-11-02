import type { RuntimeSessionDetailView } from "../../protocol/session-detail-protocol-types.js"

interface LoadedSessionDetail {
  readonly id: string
  readonly view: RuntimeSessionDetailView | null
  readonly loadError?: string
}

export function sessionLoadFailure(input: {
  readonly foregroundId: string | undefined
  readonly hasCatalogRow: (sessionId: string) => boolean
  readonly loaded: LoadedSessionDetail | undefined
}): string {
  const id = input.foregroundId
  if (!id) return ""
  if (input.hasCatalogRow(id)) return ""
  const loaded = input.loaded
  if (!loaded || loaded.id !== id) return ""
  if (loaded.loadError) return loaded.loadError
  return loaded.view === null ? "Session no longer exists" : ""
}
