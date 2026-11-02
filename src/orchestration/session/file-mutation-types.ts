type FileMutationContent = string | Uint8Array
type FileChangeKind = "created" | "modified" | "deleted"
export interface FileLineStats {
  added: number
  modified: number
  removed: number
}

export interface FileChangeObservationInput {
  mutationId: string
  path: string
  displayPath: string
  changeKind: FileChangeKind
  beforeContent: FileMutationContent | null
  afterContent: FileMutationContent | null
  diffContent?: string
  lineStats?: FileLineStats
  toolUseId: string
  modelRequestId?: string
  parentToolUseId?: string
}
