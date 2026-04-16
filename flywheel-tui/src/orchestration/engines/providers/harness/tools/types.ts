export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  handoffPath?: string;
  /** In-memory todo list state owned by the runner. */
  todoList: TodoItem[];
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}
