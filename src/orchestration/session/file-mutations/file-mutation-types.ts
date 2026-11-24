type FileMutationContent = string | Uint8Array
type FileChangeKind = "created" | "modified" | "deleted"
export interface FileChangeObservationInput {
  mutationId: string
  path: string
  displayPath: string
  changeKind: FileChangeKind
  beforeContent: FileMutationContent | null
  afterContent: FileMutationContent | null
  toolUseId: string
  modelRequestId?: string
  parentToolUseId?: string
}
