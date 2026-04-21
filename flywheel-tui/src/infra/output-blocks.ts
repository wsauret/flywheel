/** Lives in infra/ so both layers can import without crossing module boundaries. */

import { z } from "zod"

const TextBlockSchema = z.object({
  kind: z.literal("text"),
  content: z.string(),
  timestamp: z.number(),
})

/**
 * Optional fields (errorMessage, completed) are NOT discriminated by status because
 * StructuredOutputBuilder mutates blocks via spread (`{ ...block, errorMessage }`).
 * A discriminated union would break that pattern — errorMessage and completed are
 * post-hoc mutations applied when tool_result events arrive, not construction-time fields.
 */
const ToolEntrySchema = z.object({
  kind: z.literal("tool"),
  name: z.string(),
  detail: z.string(),
  timestamp: z.number(),
  /** Absolute file path — when present, detail is clickable and opens in editor */
  filePath: z.string().optional(),
  /** Unified diff string for Edit/ApplyPatch tools */
  diff: z.string().optional(),
  /** Raw file content for Write tool (rendered inline, not diff) */
  content: z.string().optional(),
  /** File type for syntax highlighting in diff rendering */
  filetype: z.string().optional(),
  /** Error message from tool_result when is_error is true */
  errorMessage: z.string().optional(),
  /** Marked true when the corresponding tool_result arrives */
  completed: z.boolean().optional(),
})

/**
 * Optional fields (duration, errorMessage) are NOT discriminated by status because
 * StructuredOutputBuilder mutates blocks via spread (`{ ...agent, status, duration }`).
 * A discriminated union would break that pattern — TypeScript can't spread across
 * discriminants cleanly. The builder is the sole writer and always pairs status with
 * the correct fields, so the optionality is safe in practice.
 */
const ToolGroupBlockSchema = z.object({
  kind: z.literal("toolGroup"),
  id: z.string(),
  groupKind: z.enum(["agent", "tools"]),
  label: z.string(),
  description: z.string(),
  status: z.enum(["active", "completed", "error", "paused"]),
  children: z.array(ToolEntrySchema),
  latestChild: z.string().optional(),
  duration: z.number().optional(),
  errorMessage: z.string().optional(),
  timestamp: z.number(),
})

const SystemBlockSchema = z.object({
  kind: z.literal("system"),
  message: z.string(),
  timestamp: z.number(),
})

const ThinkingBlockSchema = z.object({
  kind: z.literal("thinking"),
  content: z.string(),
  timestamp: z.number(),
})

const UserMessageBlockSchema = z.object({
  kind: z.literal("userMessage"),
  content: z.string(),
  timestamp: z.number(),
  /** True while the message has been written to stdin but the agent hasn't picked it up yet. */
  pending: z.boolean().optional(),
  /** True for system-injected messages (observer, self-review). Rendered collapsed as "↳ System". */
  injected: z.boolean().optional(),
})

const TodoItemSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "abandoned"]),
  notes: z.string().optional(),
})

const TodoListBlockSchema = z.object({
  kind: z.literal("todoList"),
  todos: z.array(TodoItemSchema),
  timestamp: z.number(),
})

const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
})

const QuestionEntrySchema = z.object({
  question: z.string(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean().optional(),
})

/**
 * Optional fields (answers, cancelled) are NOT discriminated by status because
 * StructuredOutputBuilder mutates blocks via spread (`{ ...block, answers }`).
 * A discriminated union would break that pattern — answers and cancelled are
 * post-hoc mutations applied when the user resolves the dock, not construction-time fields.
 *
 * `answers` is keyed by question text matching Claude's wire format
 * (see inspiration/claude-code/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx).
 * Multi-select answers are comma-separated.
 */
const QuestionBlockSchema = z.object({
  kind: z.literal("question"),
  toolUseId: z.string(),
  questions: z.array(QuestionEntrySchema),
  answers: z.record(z.string(), z.string()).optional(),
  cancelled: z.boolean().optional(),
  timestamp: z.number(),
})

export type TextBlock = z.infer<typeof TextBlockSchema>
export type ToolEntry = z.infer<typeof ToolEntrySchema>
export type ToolGroupBlock = z.infer<typeof ToolGroupBlockSchema>
export type SystemBlock = z.infer<typeof SystemBlockSchema>
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>
export type UserMessageBlock = z.infer<typeof UserMessageBlockSchema>
export type TodoItem = z.infer<typeof TodoItemSchema>
export type TodoListBlock = z.infer<typeof TodoListBlockSchema>
type QuestionOption = z.infer<typeof QuestionOptionSchema>
export type QuestionEntry = z.infer<typeof QuestionEntrySchema>
export type QuestionBlock = z.infer<typeof QuestionBlockSchema>

/**
 * Single source of truth for block shapes. Used for in-memory validation and
 * derived by persistence (`src/orchestration/session/output-schemas.ts`) —
 * adding a new block kind here auto-includes it in save/load.
 */
export const AnyBlockSchema = z.discriminatedUnion("kind", [
  TextBlockSchema,
  ToolEntrySchema,
  ToolGroupBlockSchema,
  SystemBlockSchema,
  ThinkingBlockSchema,
  UserMessageBlockSchema,
  TodoListBlockSchema,
  QuestionBlockSchema,
])

export type AnyBlock = z.infer<typeof AnyBlockSchema>

export type ModelActivity = "idle" | "thinking" | "generating" | "tool_executing"
