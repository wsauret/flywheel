export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
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
  /** Tracks which file paths have been read during this session (for read-before-edit enforcement). */
  readFiles: Set<string>;
  /** Names of tools available in this session (for bash command interception). */
  availableTools?: ReadonlySet<string>;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned";
  priority?: "high" | "medium" | "low";
  notes?: string;
}


export interface BunSubprocessLike {
  readonly exitCode: number | null;
  readonly exited: Promise<number | null>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly pid: number;
  kill(signal?: number): void;
}

interface BashSpawnOptions {
  cwd: string;
  stdout: "pipe";
  stderr: "pipe";
}

export interface BashOperations {
  spawn(cmd: string[], opts: BashSpawnOptions): BunSubprocessLike;
  writeScript(path: string, content: string): Promise<number>;
  deleteScript(path: string): Promise<void>;
}

export interface HandoffOperations {
  writeFile(path: string, content: string): Promise<number>;
}
