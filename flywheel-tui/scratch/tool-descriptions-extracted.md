# Tool Description Extraction — All 6 Harnesses

Extracted verbatim tool description strings from each harness. For each tool, the "description" field is the text sent to the LLM as part of the tool schema.

---

## 1. CLAUDE CODE (src/tools.ts → individual tool files)

Claude Code's `tools.ts` is a registry that imports individual tool classes. The description strings live inside each tool class. Since the source was extracted as a large decompiled file, descriptions are in separate tool definition files. The key tool descriptions are referenced from `definitions/coreTools.ts` → `model-family-sets/default-legacy.ts` but the actual Claude Code (Anthropic) tool files use their own `prompt` property. The Claude Code tools.ts file is primarily a tool orchestration file — it imports tools like `BashTool`, `FileEditTool`, `FileReadTool`, etc. The actual descriptions are defined in each tool's individual file (e.g., `tools/BashTool/BashTool.ts`). These were NOT available in the inspiration directory — only the orchestration file `tools.ts` was present.

**Note:** The Claude Code `tools.ts` file in the inspiration directory is the orchestration/registry file only. Individual tool description files (BashTool.ts, FileEditTool.ts, etc.) were not included in the inspiration directory.

---

## 2. DROID (harness-logic/tools/tool-definitions.js)

### Read (CLI)
```
Read the contents of a file. By default, reads the entire file, but for large text files,
results are truncated to the first 2400 lines to preserve token usage. Use offset and limit parameters
to read specific portions of huge files when needed. Requires absolute file paths.
For image files (JPEG, PNG) up to 5MB, returns the actual image content that you can view and analyze directly.
Use image_quality="high" for higher fidelity image reading (~1MB, 2048px) when details matter.
For PDF files up to 3MB, returns the document content that you can view and analyze directly.
```

### LS (CLI)
```
List the contents of a directory with optional pattern-based filtering.
Prefer usage of 'Grep' and 'Glob' tools, for more targeted searches.
Supports ignore patterns to exclude unwanted files and directories.
Requires absolute directory paths when specified.
```

### Edit (CLI)
```
Edit the contents of a file by finding and replacing text.

Make sure the Read tool was called first before making edits, as this tool requires the file to be read first.
Preserve the exact indentation (tabs or spaces).
Never write a new file with this tool; prefer using Create tool for that.
'old_str' must be unique in the file, or 'change_all' must be true to replace all occurrences (for example, it's useful for variable renaming).
make sure to provide the larger 'old_str' with more surrounding context to narrow down the exact match.
```

### Execute (CLI)
Description is dynamically generated via `buildCommitStepDescription()`. The template is:
```
Execute a shell command with optional timeout (in seconds).

CRITICAL: Each command runs in a NEW, ISOLATED shell process. Nothing persists between Execute calls:
- Environment variables are reset
- Virtual environment activations are lost
- Working directory changes are lost
- Installed packages remain, but PATH changes are lost

Before executing commands:

1. Directory Verification:
   - If creating new directories or files, first use the LS tool to verify the parent directory exists
   - Example: Before running "mkdir src/components/NewFeature", use LS to check that "src/components" exists

2. Path Quoting:
   Always quote file paths that contain spaces or special characters like '(', ')', '[', ']' with double quotes:
   CORRECT:
   - cd "/Users/name/My Documents"
   - cd "/Users/project/(session)/routes"
   - python "/path/with spaces/script.py"
   - rm "/tmp/file (copy).txt"
   - ls "/path/with[brackets]/file.txt"

   INCORRECT (will fail):
   - cd /Users/name/My Documents
   - cd /Users/project/(session)/routes
   - python /path/with spaces/script.py
   - rm /tmp/file (copy).txt
   - ls /path/with[brackets]/file.txt

3. Working Directory Management:
   Prefer using absolute paths over changing directories:
   GOOD: pytest /project/tests
   BAD: cd /project && pytest tests

Tool Usage Guidelines:
- Prefer 'Read' tool over cat, head, tail, sed, or awk for viewing files
- Prefer 'LS' tool over ls for exploring directories
- Prefer 'Create' tool for creating new files
- Prefer 'Edit' and 'MultiEdit' tools for modifying files
- Prefer 'Grep' and 'Glob' tools for searching (never use grep or find commands)
- If you need grep, use 'rg' (ripgrep) which is pre-installed and faster
- Avoid wrapping commands with 'bash -lc', 'zsh -lc', or 'sh -c'

[... continues with Artifacts Directory Protection, Python Package Management, Environment Variables, Git Safety Guidelines, Output Limits, Security, Timeout, Background processes, Committing changes with git, Creating pull requests sections ...]
```
(Full text is in the Droid tool-definitions.js file — too long to repeat here but was read in full above)

### Grep (CLI)
```
High-performance file content search using ripgrep. Wrapper around ripgrep with comprehensive parameter support.

Supports ripgrep parameters:
- Pattern matching with regex support
- File type filtering (--type js, --type py, etc.)
- Glob pattern filtering (--glob "*.js")
- Case-insensitive search (-i)
- Context lines (-A, -B, -C for after/before/around context)
- Line numbers (-n)
- Multiline mode (-U --multiline-dotall)
- Custom search directories

Output modes:
- file_paths: Returns only matching file paths (default, fast)
- content: Returns matching lines with optional context, line numbers, and formatting

PERFORMANCE TIP: When exploring codebases or searching for patterns, make multiple speculative Grep tool calls in a single response to speed up the discovery phase. For example, search for different patterns, file types, or directories simultaneously.

Returns search results based on the selected output mode.
```

### Glob (CLI)
```
Advanced file path search using glob patterns with multiple pattern support and exclusions.
Uses ripgrep for high-performance file pattern matching.
Supports:
- Multiple inclusion patterns (OR logic)
- Exclusion patterns to filter out unwanted files
Common patterns:
- "*.ext" - all files with extension
- "**/*.ext" - all files with extension in any subdirectory
- "dir/**/*" - all files under directory
- "{*.js,*.ts}" - multiple extensions
- "!node_modules/**" - exclude pattern

PERFORMANCE TIP: When exploring codebases or discovering files for a task, make multiple speculative Glob tool calls in a single response to speed up the discovery phase. For example, search for different file types or directories that might be relevant to your task simultaneously.

Returns a list of matched file paths.

Never use 'glob' cli command directly via Execute tool, use this Glob tool instead. It's optimized for performance and handles multiple patterns and exclusions.
```

### Create (CLI)
```
Creates a new file on the file system with the specified content. Prefer editing existing files, unless you need to create a new file.
```

### Fetch URL
```
Scrapes content from URLs that the user provided, and returns the contents in markdown format. This tool supports both generic webpages and specific integration URLs.

CRITICAL: BEFORE CALLING THIS TOOL, CHECK IF THE URL WILL FAIL

URLs THAT WILL ALWAYS FAIL - DO NOT ATTEMPT TO FETCH:

1. LOCAL/PRIVATE NETWORK URLs:
   - http://localhost:* (any port)
   - http://127.0.0.1:* or http://[::1]:*
   [... full list of blocked URLs ...]

SUPPORTED INTEGRATION URLS (requires setup at https://app.factory.ai/settings/integrations):
- Google Docs, Notion Pages, Linear Issues, GitHub PRs/Issues, etc.

DO NOT use this tool for:
- URLs not explicitly provided by the user
- Web searching (use web_search tool instead)
- Any URL matching the failure patterns above
```

### Glob Search (Server)
```
Searches for files using glob patterns to match file paths in the repo. Returns a list of matched file paths. If over ${MAX_SEARCH_RESULTS} results are found, the results will be truncated.
If CLI tool is enabled, use the CLI tool for glob search, instead of calling this glob tool directly.
```

### Grep Search (Server)
```
Searches for files whose contents match a regex or literal string pattern. Returns a list of matched file paths. If over ${MAX_SEARCH_RESULTS} results are found, the results will be truncated.
```

### Shell Execute (Server)
```
Executes a shell command in the workspace synchronously. For Git operations (fetch/pull/commit/push) and dependency bootstrapping (npm ci, pnpm install --frozen-lockfile, yarn install --frozen-lockfile, pip/poetry install, cargo fetch, go mod download), it waits for completion, captures stdout/stderr and exit code, and blocks subsequent steps until the command succeeds. Runs non-interactively (CI=1; use --yes/--non-interactive where available), supports cwd/env overrides, redacts secrets in logs, and fails fast on non-zero exit. Use --ff-only for git pull and do not proceed from a dirty worktree unless explicitly instructed.
```

### View File (Server)
```
Retrieves and displays the contents of a specified file. Do not add quotes to the input parameters.
By default, it returns up to ${MAX_FILE_LINES} lines starting from the beginning of the file.
You can optionally specify a line start and end (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.
Only files within the current working directory can be viewed.
```

### View Folder (Server)
```
Lists the contents of a specified directory. Returns output similar to the ls command. Do not add quotes to the input parameters.
```

---

## 3. FORGE (crates/forge_domain/src/tools/descriptions/*.md)

### fs_read.md
```
Reads a file from the local filesystem. You can access any file directly by using this tool. Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to {{config.maxReadSize}} lines starting from the beginning of the file
- You can optionally specify a line start_line and end_line (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than {{config.maxLineLength}} characters will be truncated
- Results are returned using rg "" -n format, with line numbers starting at 1
{{#if (contains model.input_modalities "image")}}
- This tool allows Forge Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually.
- PDFs, Automatically encoded as base64 and sent as visual content for LLM to analyze pages. Any PDFs larger than {{config.maxImageSize}} bytes will return error
{{/if}}
- Jupyter notebooks (.ipynb files) are read as plain JSON text - you can parse the cell structure, outputs, and embedded content directly from the JSON
- This tool can only read files, not directories. To read a directory, use an ls command via the `{{tool_names.shell}}` tool.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
```

### fs_patch.md
```
Performs exact string replacements in files.
Usage:
- You must use your `{{tool_names.read}}` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. 
- When editing text from `{{tool_names.read}}` tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: 'line_number:'. Everything after that line_number: is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`. 
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
```

### fs_multi_patch.md
```
This is a tool for making multiple edits to a single file in one operation. It is built on top of the {{tool_names.patch}} tool and allows you to perform multiple find-and-replace operations efficiently. Prefer this tool over the {{tool_names.patch}} tool when you need to make multiple edits to the same file.

Before using this tool:
1. Use the Read tool to understand the file's contents and context
2. Verify the directory path is correct

To make multiple file edits, provide the following:
1. file_path: The absolute path to the file to modify (must be absolute, not relative)
2. edits: An array of edit operations to perform, where each edit contains:
   - oldString: The text to replace (must match the file contents exactly, including all whitespace and indentation)
   - newString: The edited text to replace the oldString
   - replaceAll: Replace all occurrences of oldString. This parameter is optional and defaults to false.

IMPORTANT:
- All edits are applied in sequence, in the order they are provided
- Each edit operates on the result of the previous edit
- All edits must be valid for the operation to succeed - if any edit fails, none will be applied
- This tool is ideal when you need to make several changes to different parts of the same file

[... full text continues with CRITICAL REQUIREMENTS, WARNING sections ...]
```

### fs_write.md
```
Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the {{tool_names.read}} tool first to read the file's contents and use this tool with 'overwrite' as true . This tool will fail if you did not read the file first or don't set overwrite parameter to true.
- ALWAYS prefer {{tool_names.patch}} on existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
```

### fs_search.md
```
A powerful search tool built on ripgrep

Usage:
- ALWAYS use `{{tool_names.fs_search}}` for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The `{{tool_names.fs_search}}` tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Use Task tool for open-ended searches requiring multiple rounds
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`
```

### shell.md
```
Executes shell commands. The `cwd` parameter sets the working directory for command execution. If not specified, defaults to `{{env.cwd}}`.

CRITICAL: Do NOT use `cd` commands in the command string. This is FORBIDDEN. Always use the `cwd` parameter to set the working directory instead. Any use of `cd` in the command is redundant, incorrect, and violates the tool contract.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

[... full text continues with Directory Verification, Command Execution, Usage notes sections ...]
```

### todo_write.md
```
Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## How It Works

Each call sends only the items that changed — you do not need to repeat the whole list.

Each item has two required fields:
- `content`: The task description. This is the **unique key** — the server matches on content to decide whether to add or update.
- `status`: One of `pending`, `in_progress`, `completed`, or `cancelled`.

[... full text continues with Rules, When to Use, Examples, Task States sections ...]
```

### todo_read.md
```
Retrieves the current todo list for this coding session. Use this tool to check existing todos before making updates, or to review the current state of tasks at any point during the session.

## When to Use This Tool
- Before calling `todo_write`, to understand which tasks already exist and avoid duplicates
- When you need to know what tasks are pending, in progress, or completed
- To resume work after a break and understand the current state of tasks
- When the user asks about the current task list or progress

## Output
Returns all current todos with their IDs, content, and status (`pending`, `in_progress`, `completed`). If no todos exist yet, returns an empty list.
```

### semantic_search.md
```
AI-powered semantic code search. YOUR DEFAULT TOOL for code discovery and exploration when searching within {{env.cwd}}. Use this when you need to find code locations, understand implementations, discover patterns, or explore unfamiliar code - it works with natural language about behavior and concepts, not just keyword matching.

**WHEN TO USE sem_search:**
- Finding implementation of specific features or algorithms
- Understanding how a system works across multiple files
- Discovering architectural patterns and design approaches
- Locating test examples or fixtures
- Finding where specific technologies/libraries are used
- Exploring unfamiliar codebases to learn structure
- Finding documentation files (README, guides, API docs)

**WHEN NOT TO USE (use {{tool_names.fs_search}} instead):**
- Searching for exact strings, TODOs, or specific function names
- Finding all occurrences of a variable or identifier
- Searching in specific file paths or with regex patterns
- When you know the exact text to search for

[... full text continues with TIPS FOR SUCCESS section ...]
```

---

## 4. GEMINI CLI (packages/core/src/tools/definitions/model-family-sets/default-legacy.ts)

### read_file
```
Reads and returns the content of a specified file. If the file is large, the content will be truncated. The tool's response will clearly indicate if truncation has occurred and will provide details on how to read more of the file using the 'start_line' and 'end_line' parameters. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), audio files (MP3, WAV, AIFF, AAC, OGG, FLAC), and PDF files. For text files, it can read specific line ranges.
```

### write_file
```
Writes content to a specified file in the local filesystem.

The user has the ability to modify `content`. If modified, this will be stated in the response.
```

### grep_search
```
Searches for a regular expression pattern within file contents. Max 100 matches.
```

### grep_search_ripgrep
```
Searches for a regular expression pattern within file contents.
```

### glob
```
Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases.
```

### list_directory
```
Lists the names of files and subdirectories directly within a specified directory path. Can optionally ignore entries matching provided glob patterns.
```

### replace (Edit)
```
Replaces text within a file. By default, the tool expects to find and replace exactly ONE occurrence of `old_string`. If you want to replace multiple occurrences of the exact same string, set `allow_multiple` to true. This tool requires providing significant context around the change to ensure precise targeting. Always use the read_file tool to examine the file's current content before attempting a text replacement.
      
The user has the ability to modify the `new_string` content. If modified, this will be stated in the response.
      
Expectation for required parameters:
1. `old_string` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).
```

### google_web_search
```
Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.
```

### web_fetch
```
Processes content from URL(s), including local and private network addresses (e.g., localhost), embedded in a prompt. Include up to 20 URLs and instructions (e.g., summarize, extract specific data) directly in the 'prompt' parameter.
```

### read_many_files
```
Reads content from multiple files specified by glob patterns within a configured target directory. For text files, it concatenates their content into a single string. It is primarily designed for text-based files. However, it can also process image (e.g., .png, .jpg), audio (e.g., .mp3, .wav), and PDF (.pdf) files if their file names or extensions are explicitly included in the 'include' argument. For these explicitly requested non-text files, their data is read and included in a format suitable for model consumption (e.g., base64 encoded).

This tool is useful when you need to understand or analyze a collection of files, such as:
- Getting an overview of a codebase or parts of it (e.g., all TypeScript files in the 'src' directory).
- Finding where specific functionality is implemented if the user asks broad questions about code.
- Reviewing documentation files (e.g., all Markdown files in the 'docs' directory).
```

### write_todos
```
This tool can help you list out the current subtasks that are required to be completed for a given user request. The list of subtasks helps you keep track of the current task, organize complex queries and help ensure that you don't miss any steps. With this list, the user can also see the current progress you are making in executing a given task.

Depending on the task complexity, you should first divide a given task into subtasks and then use this tool to list out the subtasks that are required to be completed for a given user request.
Each of the subtasks should be clear and distinct. 

Use this tool for complex queries that require multiple steps. If you find that the request is actually complex after you have started executing the user task, create a todo list and use it. If execution of the user task requires multiple steps, planning and generally is higher complexity than a simple Q&A, use this tool.
```

### save_memory
```
Saves concise user context (preferences, facts) for use across future sessions.

Supports two scopes:
- **global** (default): Cross-project preferences loaded in every workspace. Use for "Remember X" or clear personal facts.
- **project**: Facts specific to the current workspace, private to the user (not committed to the repo). Use for local dev setup notes, project-specific workflows, or personal reminders about this codebase.
```

### enter_plan_mode
```
Switch to Plan Mode to safely research, design, and plan complex changes using read-only tools.
```

### ask_user
```
Ask the user one or more questions to gather preferences, clarify requirements, or make decisions.
```

### Shell (run_shell_command) — dynamic, constructed via `getShellDeclaration()` helper. Not statically available in default-legacy.ts.

---

## 5. OH-MY-PI (packages/coding-agent/src/prompts/tools/*.md)

All descriptions are Handlebars-templated markdown files.

### bash.md
```
Executes bash command in shell session for terminal operations like git, bun, cargo, python.

<instruction>
- You **MUST** use `cwd` parameter to set working directory instead of `cd dir && …`
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values instead of inlining them into shell syntax; reference them from the command as `$NAME`
- Quote variable expansions like `"$NAME"` to preserve exact content and avoid shell parsing bugs
- PTY mode is opt-in: set `pty: true` only when command expects a real terminal (for example `sudo`, `ssh` where you need input from the user); default is `false`
- You **MUST** use `;` only when later commands should run regardless of earlier failures
[... async/auto-background sections with Handlebars conditionals ...]
</instruction>

<critical>
You **MUST** use specialized tools instead of bash for ALL file operations:
[... table of wrong vs correct tool usage ...]
- You **MUST NOT** use Bash for these operations like read, grep, find, edit, write, where specialized tools exist.
- You **MUST NOT** use `2>&1` | `2>/dev/null` pattern, stdout and stderr are already merged.
- You **MUST NOT** use `| head -n 50` or `| tail -n 100` pattern, use `head` and `tail` parameters instead.
</critical>
```

### grep.md
```
Searches files using powerful regex matching.

<instruction>
- Supports full regex syntax (e.g., `log.*Error`, `function\\s+\\w+`); literal braces need escaping (`interface\\{\\}` for `interface{}` in Go)
- `path` may be a file, directory, glob path, or comma-separated path list; pair it with `glob` when you need an additional relative file filter
- Filter files with `glob` (e.g., `*.js`, `**/*.tsx`) or `type` (e.g., `js`, `py`, `rust`)
- Respects `.gitignore` by default; set `gitignore: false` to include ignored files
- For cross-line patterns like `struct \\{[\\s\\S]*?field`, set `multiline: true` if needed
- If the pattern contains a literal `\n`, multiline defaults to true
</instruction>

<critical>
- You **MUST** use Grep when searching for content.
- You **MUST NOT** invoke `grep` or `rg` via Bash.
- If the search is open-ended, requiring multiple rounds, you **MUST** use Task tool with explore subagent instead.
</critical>
```

### read.md
```
Reads the content at the specified path or URL.

<instruction>
The `read` tool is a multi-purpose tool that can be used to inspect all kinds of files and URLs.
- You **MUST** parallelize reads when exploring related files

## Parameters
- `path` -- file path or URL (required)
- `sel` -- optional selector for line ranges or raw mode
- `timeout` -- seconds, for URLs only

## Selectors
|`sel` value|Behavior|
|---|---|
|*(omitted)*|Read full file (up to {{DEFAULT_LIMIT}} lines)|
|`L50`|Read from line 50 onward|
|`L50-L120`|Read lines 50 through 120|
|`raw`|Raw content without transformations (for URLs: untouched HTML)|

Max {{DEFAULT_MAX_LINES}} lines per call.

# Filesystem, Inspection, Directories & Archives, SQLite Databases, URLs sections...
</instruction>

<critical>
- You **MUST** use `read` instead of bash for ALL file reading: `cat`, `head`, `tail`, `less`, `more` are FORBIDDEN.
- You **MUST** use `read` instead of `ls` for directory listings.
- You **MUST** use `read` instead of shelling out to `tar` or `unzip` for supported archive reads.
- You **MUST** always include the `path` parameter, NEVER call `read` with empty arguments `{}`.
</critical>
```

### write.md
```
Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Supports `.tar`, `.tar.gz`, `.tgz`, and `.zip` archive entries via `archive.ext:path/inside/archive`
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
</conditions>

<critical>
- You **SHOULD** use Edit tool for modifying existing files (more precise, preserves formatting)
- You **MUST NOT** create documentation files (*.md, README) unless explicitly requested
- You **MUST NOT** use emojis unless requested
</critical>
```

### patch.md (Edit)
```
Patches files given diff hunks. Primary tool for existing-file edits.

<instruction>
**Hunk Headers:**
- `@@` — bare header when context lines unique
- `@@ $ANCHOR` — anchor copied verbatim from file (full line or unique substring)
**Anchor Selection:**
1. Otherwise choose highly specific anchor copied from file: full function signature, class declaration, unique string literal/error message, config key with uncommon name
2. On "Found multiple matches": add context lines, use multiple hunks with separate anchors, or use longer anchor substring
**Context Lines:**
Use enough ` `-prefixed lines to make match unique (usually 2–8)
</instruction>

<parameters>
type Entry =
   | { path: string, op: "update", diff: string }
   | { path: string, op: "create", diff: string }
   | { path: string, op: "delete" }
   | { path: string, op: "update", rename: string, diff: string }
</parameters>

<critical>
- You **MUST** read the target file before editing
- You **MUST** copy anchors and context lines verbatim (including whitespace)
- You **MUST NOT** use anchors as comments
- If edit fails or breaks structure, you **MUST** re-read the file and produce a new patch from current content
- **NEVER** use edit to fix indentation, whitespace, or reformat code
</critical>
```

### chunk-edit.md
```
Edits files via syntax-aware chunks. Run `read(path="file.ts")` first.
- `write` rewrites the entire targeted region — best for most edits.
- `replace` does surgical find-and-replace within a chunk — use when making small changes to a large chunk, or batching multiple substitutions.
- `insert` adds content before/after a chunk.

Call format: `{"edits": [{"path": "file:chunk#ID~", "write": "new body"}, …]}`

[... extensive rules, regions, ops, examples sections ...]
```

### ast-grep.md
```
Performs structural code search using AST matching via native ast-grep.

<instruction>
- Use this when syntax shape matters more than raw text
- Prefer a precise `path` scope to keep results targeted and deterministic
- `pat` is required and must include at least one non-empty AST pattern; `lang` is optional
- Multiple patterns run in one native pass; results are merged
[... extensive instruction, examples, critical sections ...]
</instruction>
```

### ast-edit.md
```
Performs structural AST-aware rewrites via native ast-grep.

<instruction>
- Use for codemods and structural rewrites where plain text replace is unsafe
- Narrow scope with `path` before replacing
[... extensive instruction, examples, critical sections ...]
</instruction>
```

### todo-write.md
```
Manages a phased task list. Each field is a verb — set the ones you need in a single call.
The next pending task is auto-promoted to `in_progress` after completing the current one.

<protocol>
## Fields
|Field|Type|When to use|
|---|---|---|
|`phases`|Phase[]|Initial setup, or full restructure when the plan changes significantly|
|`complete`|string[]|Mark tasks done|
|`start`|string|Jump to a specific task out of order|
|`abandon`|string[]|Drop tasks intentionally|
|`remove`|string[]|Remove tasks that are no longer relevant|
|`add_notes`|{id, notes}[]|Append runtime observations to tasks|
|`add_tasks`|{phase, content, details?}[]|Add tasks to a phase (by name or ID)|
|`add_phase`|{name, tasks?}|Add a new phase of work discovered mid-task|

## Task Anatomy
- `content`: Short label (5-10 words). What is being done, not how.
- `details`: File paths, implementation steps, edge cases. Shown only when task is active.
</protocol>

<conditions>
Create a todo list when:
1. Task requires 3+ distinct steps
2. User explicitly requests one
3. User provides a set of tasks to complete
4. New instructions arrive mid-task — capture before proceeding
</conditions>
```

### search-tool-bm25.md
```
Search hidden MCP tool metadata when MCP tool discovery is enabled.

Use this tool to discover MCP tools that are loaded into the session but not exposed to the model by default.

[... details about discoverable MCP servers, input parameters, behavior, notes ...]
```

### read-chunk.md
```
Reads files using syntax-aware chunks.

<instruction>
- `path` — file path or URL; may include `:selector` suffix
- `sel` — optional selector: `class_Foo`, `class_Foo.fn_bar#ABCD~`, `?`, `L50`, `L50-L120`, or `raw`
- `timeout` — seconds, for URLs only

[... chunk tree details, SQLite database access ...]
</instruction>

<critical>
- **MUST** `read` before editing — never invent chunk names or IDs.
- Chunk names are truncated (e.g., `handleRequest` becomes `fn_handleRequ`). Always copy chunk paths from `read` or `?` output — never construct them from source identifiers.
</critical>
```

---

## 6. CODEX (codex-rs/)

### apply_patch (codex-rs/apply-patch/apply_patch_tool_instructions.md)
```
## `apply_patch`

Use the `apply_patch` shell command to edit files.
Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change.
- If 3 lines of context is insufficient to uniquely identify the snippet, use the @@ operator to indicate the class or function.
- If a code block is repeated so many times, you can use multiple @@ statements.

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

It is important to remember:
- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with `+` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.
```

### System Prompt (codex-rs/core/prompt_with_apply_patch_instructions.md)
The full system prompt includes the apply_patch instructions embedded within a comprehensive system prompt that covers:
- Agent personality and capabilities
- AGENTS.md spec
- Responsiveness guidelines (preamble messages)
- Planning (update_plan tool)
- Task execution guidelines
- Coding guidelines
- Validation guidelines
- Tool guidelines (shell commands, update_plan, apply_patch)
- Final answer formatting guidelines

The `apply_patch` section in the system prompt is identical to the standalone `apply_patch_tool_instructions.md`.

The system prompt also contains shell tool guidance:
```
When using the shell, you must adhere to the following guidelines:
- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)
- Do not use python scripts to attempt to output larger chunks of a file.
```

---

## NOTES

- **Claude Code**: Only the tool orchestration file (`tools.ts`) was in the inspiration directory. Individual tool description files (BashTool.ts, FileEditTool.ts, etc.) were not present.
- **Droid**: Complete tool definitions extracted from the deobfuscated `tool-definitions.js`.
- **Forge**: All descriptions use Handlebars templating with `{{tool_names.*}}`, `{{config.*}}`, and `{{env.*}}` variables.
- **Gemini CLI**: Tool descriptions come from `definitions/model-family-sets/default-legacy.ts`. The shell tool description is dynamically generated.
- **Oh-My-Pi**: All descriptions are Handlebars-templated `.md` files with `<instruction>`, `<critical>`, `<output>`, `<conditions>` XML-like sections.
- **Codex**: Uses a single `apply_patch` tool with a custom patch language. The full system prompt embeds the patch instructions inline.
