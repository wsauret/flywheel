type RuntimeAuthProfileDefaultScope = { readonly kind: "defaults" }

interface RuntimeAuthProfileDescriptor {
  readonly id: string
  readonly displayName: string
}

export type RuntimeAuthProfileDeletionPreview =
  | { readonly kind: "fresh-default"; readonly source: RuntimeAuthProfileDescriptor }
  | { readonly kind: "automatic"; readonly source: RuntimeAuthProfileDescriptor; readonly successor: RuntimeAuthProfileDescriptor }
  | { readonly kind: "choose"; readonly source: RuntimeAuthProfileDescriptor; readonly candidates: readonly RuntimeAuthProfileDescriptor[] }

export type RuntimeAuthProfileScope =
  | RuntimeAuthProfileDefaultScope
  | { readonly kind: "session"; readonly sessionId: string }

export type RuntimeAuthProfileWriteScope =
  | RuntimeAuthProfileScope
  | { readonly kind: "defaults-and-session"; readonly sessionId: string }

export interface RuntimeAuthProfileSelectMutation {
  readonly type: "auth.profile.select"
  readonly scope: RuntimeAuthProfileWriteScope
  readonly id: string
}

export interface RuntimeAuthProfileCreateMutation {
  readonly type: "auth.profile.create"
  readonly scope: RuntimeAuthProfileWriteScope
  readonly displayName: string
}

export interface RuntimeAuthProfileRenameMutation {
  readonly type: "auth.profile.rename"
  readonly scope: RuntimeAuthProfileDefaultScope
  readonly id: string
  readonly displayName: string
}

export interface RuntimeAuthProfileBindMutation {
  readonly type: "auth.profile.bind_current_project"
  readonly scope: RuntimeAuthProfileDefaultScope
  readonly id: string
}

export interface RuntimeAuthProfileUnbindMutation {
  readonly type: "auth.profile.unbind_current_project"
  readonly scope: RuntimeAuthProfileDefaultScope
}


export interface RuntimeAuthProfileDeleteMutation {
  readonly type: "auth.profile.delete"
  readonly scope: RuntimeAuthProfileDefaultScope
  readonly id: string
  /** Exact confirmed destination; null confirms creation of a fresh Default. */
  readonly successorId: string | null
}
export type RuntimeAuthProfileMutation =
  | RuntimeAuthProfileSelectMutation
  | RuntimeAuthProfileCreateMutation
  | RuntimeAuthProfileRenameMutation
  | RuntimeAuthProfileBindMutation
  | RuntimeAuthProfileUnbindMutation
  | RuntimeAuthProfileDeleteMutation

export interface RuntimeAuthProfileSelectResult {
  readonly id: string
  readonly warning?: string
  readonly mirrored?: boolean
}

export interface RuntimeAuthProfileCreateResult {
  readonly id: string
  readonly warning?: string
  readonly mirrored?: boolean
}

export interface RuntimeAuthProfileRenameResult {
  readonly id: string
  readonly displayName: string
}

export interface RuntimeAuthProfileBindResult {
  readonly id: string
  readonly warning?: string
}

export interface RuntimeAuthProfileUnbindResult {
  readonly bound: false
  readonly warning?: string
}

export interface RuntimeAuthProfileDeleteResult {
  readonly id: string
  readonly warning?: string
}

type RuntimeAuthProfileMutationSuccess =
  | RuntimeAuthProfileSelectResult
  | RuntimeAuthProfileCreateResult
  | RuntimeAuthProfileRenameResult
  | RuntimeAuthProfileBindResult
  | RuntimeAuthProfileUnbindResult
  | RuntimeAuthProfileDeleteResult

export type RuntimeAuthProfileMutationResult =
  | RuntimeAuthProfileMutationSuccess
  | { readonly ok: false; readonly error: string }

