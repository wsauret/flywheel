import type {
  BranchSummaryEntrySchema,
  CompactionEntrySchema,
  LeafEntrySchema,
  MessageEntrySchema,
  ConversationEntrySchema,
} from "./conversation-entry-schemas.js";

export type MessageEntry = typeof MessageEntrySchema.Type;
export type CompactionEntry = typeof CompactionEntrySchema.Type;
export type BranchSummaryEntry = typeof BranchSummaryEntrySchema.Type;
export type LeafEntry = typeof LeafEntrySchema.Type;
export type ConversationEntry = typeof ConversationEntrySchema.Type;
