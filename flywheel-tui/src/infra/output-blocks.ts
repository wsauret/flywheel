import { z } from "zod"

const TextBlockSchema = z.object({
  kind: z.literal("text"),
  content: z.string(),
  timestamp: z.number(),
})

// Optional fields (errorMessage, completed) are not discriminated by status because
// the builder mutates blocks via spread — these are post-hoc mutations, not construction-time.
const ToolEntrySchema = z.object({
  kind: z.literal("tool"),
  name: z.string(),
  detail: z.string(),
  timestamp: z.number(),
  filePath: z.string().optional(),
  diff: z.string().optional(),
  content: z.string().optional(),
  filetype: z.string().optional(),
  errorMessage: z.string().optional(),
  completed: z.boolean().optional(),
})

// Same spread-mutation rationale as ToolEntrySchema above.
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
  pending: z.boolean().optional(),
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

// Same spread-mutation rationale as ToolEntrySchema above.
// `answers` is keyed by question text matching Claude's wire format.
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
