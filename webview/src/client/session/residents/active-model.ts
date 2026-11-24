import type { ModelSelectionSlot } from "../../../../../src/protocol/auth/model-assignment-protocol-types.js"

export const CHAT_SLOT: ModelSelectionSlot = { kind: "role", roleId: "chat" }

export interface ActiveModel {
  readonly model: string
  readonly effort: string
}

