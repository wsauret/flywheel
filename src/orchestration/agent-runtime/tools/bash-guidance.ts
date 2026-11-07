import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { RuntimePlatform } from "./bash-script.js";
import { SEARCH_CPU_LIMIT_SECONDS, SHELL_SEARCH_PROGRAMS, SHELL_SEARCH_RULES, type ShellSearchProgram } from "./search-rules.js";
import type { RuntimeTool } from "./types.js";

export const SHELL_OUTPUT_GUIDANCE = "Preserve live command output. The runtime captures and streams stdout and stderr for foreground and managed commands. Never redirect, suppress, filter, or capture diagnostic output with `>`, `>>`, `2>`, `2>&1`, `&>`, `/dev/null`, or log-filtering pipes. Keep finite commands in the foreground. If the runtime transfers a command to managed execution, inspect output with process read_output or the completion notification. Redirect stdout only when stdout is the requested file artifact.";

const mutationGuidance = (has: CapabilityCheck): string => {
  const reviewedLike = has("edit") && has("write") ? "an edit or write tool change" : "a file edit";
  const scripts = has("write") ? " Create files to run, such as scratch scripts, with the write tool; bash only runs them." : "";
  return `Run Git commands as separate calls without mutates. Never chain a Git command onto a mutating command. Git commands that change the repository are refused inside mutates: true; rerun them as a separate call without mutates. Read-only Git commands, including scripts and build tools that only read Git, remain allowed inside mutating commands. Set mutates: true only when the command's purpose is to change the project files you are working on, so that the change is recorded and reviewed like ${reviewedLike}. Examples: heredoc and cat > writes, sed -i, Python or Bun scripts that rewrite files, formatters, code generators, and plain mv and rm. Leave it unset when the writes are side effects of running something: installing dependencies or binaries, builds, tests, caches, and servers. Write this field first, before command. Name the target tree with cwd, not an absolute cd in the command. Use relative project paths: the command runs in a private copy, and only its changes to file contents land when it exits. Processes it starts can end when it exits, so start servers and watchers in a separate call without mutates. Git objects, the index, refs, and stash changes never land from the copy.${scripts}`;
};

const timeoutGuidance = (background: boolean, persistence: boolean): string => `Timeouts are entirely optional and should be used sparingly. They apply equally to foreground and managed ${background ? "background " : ""}commands. Set one only when the command must stop at that deadline.${persistence ? " Persistent commands that outlive the runtime cannot use a timeout." : ""} A timeout can be at most 3600 seconds, remains active after a managed transfer, and terminates the process group on expiry.`;

/** The fields of a bash schema after `mutates`, in order. Timeout and
 *  persistence rules live on their fields. */
const commandProperties = (background: boolean, persistence: boolean) => ({
  command: { type: "string", description: "The shell command to execute" },
  cwd: { type: "string", description: "Working directory for the command (default: project root)" },
  timeout: { type: "number", description: timeoutGuidance(background, persistence) },
  ...(background ? { background: { type: "boolean", description: "Run the command as a managed background process." } } : {}),
  ...(persistence ? { persist_after_exit: { type: "boolean", description: "Allow this explicit background command to outlive the runtime. Without it, runtime exit ends the command. The runtime can inspect and stop it during this invocation. After the runtime exits, it cannot manage, stop, report, or enforce a timeout for it. Requires background=true and cannot be combined with timeout." } } : {}),
  raw_output: { type: "boolean", description: "Skip output compression for this call (default: false). Output from a command that starts with bun test or bun run test drops passing-test lines when it exceeds 200 lines. Other output over about 28,000 bytes keeps about the first 6,000 and the last 12,000 bytes, and error or warning lines. Each dropped run shows an omission marker, and a notice names the file that holds the full output. Prefer streaming and chunked processing over loading everything into memory." },
});

const HEAD_START = "Execute a shell command in an isolated session. Each call spawns a fresh process; environment variables, working directory changes, and shell state do not persist between calls. Commands run in bash on macOS/Linux and PowerShell on Windows. Use the cwd parameter to set the working directory instead of cd. Always quote paths containing spaces or special characters (parentheses, brackets). Chain dependent commands with && or ; within one call";
const headEnd = (background: boolean) => `. A command that reads text typed into the terminal, such as a password, passphrase, or confirmation prompt, or a login that asks for a code or token at the prompt, belongs to the person: ${background ? "never start it in the background, and ask" : "ask"} the person to run it. A login that sends the person to a browser and only waits for the browser to finish, such as \`aws sso login\` or another SSO or device-code flow, reads nothing from the terminal: run it yourself in the foreground, and before you start it, tell the person to complete it in the browser.`;
// The commands that a person runs at the prompt or in a browser have no reader in an unattended chat.
const head = (mutatingDeclaration: boolean, background: boolean, unattendedChat: boolean) => `${HEAD_START}${mutatingDeclaration ? ", but keep Git commands separate from mutating commands" : ""}${unattendedChat ? "." : headEnd(background)}`;
const STOP_BY_ID = "Stop a process by its process-tool id or its exact PID. Do not match on a process name or a command-line pattern, because a pattern can also match unrelated processes.";
// Detach is a client control, which an unattended chat has no person to select.
const finiteCommands = (unattendedChat: boolean): string => unattendedChat ? "" : " Finite commands remain in this call until they complete, you select Detach, or they reach the configured runtime cap.";
const backgroundGuidance = (unattendedChat: boolean): string => `Set background: true only for a server, service, or other command that must remain running; never use shell-level &, nohup, or disown. A managed background command ends when its runtime exits.${finiteCommands(unattendedChat)} The process tool can wait on any managed background command, whether launched with background=true or transferred from the foreground. Wait for completion or inspect its status before relying on its output; never poll with sleep or restart a command just to wait, because a managed command publishes a completion notification. ${STOP_BY_ID}`;
const foregroundOnly = (unattendedChat: boolean): string => `Never use shell-level &, nohup, or disown.${finiteCommands(unattendedChat)} The process tool can wait on a managed command that transferred from the foreground. Wait for completion or inspect its status before relying on its output; never poll with sleep or restart a command just to wait, because a managed command publishes a completion notification. ${STOP_BY_ID}`;
const VENV = "If the project uses Python virtualenvs, each call is a fresh shell so activations are lost: use venv/bin/python directly, or chain activation with `source venv/bin/activate && python script.py`.";
const SCRATCH = "Writing and running scratch scripts is a normal, expected way to work: compute results, transform data, generate diffs, drive the app, or verify behavior end-to-end. `bun` is always on PATH and runs TypeScript and JavaScript directly (`bun script.ts`, or `bun -e 'code'` for inline snippets). Put scratch scripts and their outputs in the scratchpad directory.";
const listed = (programs: readonly ShellSearchProgram[]): string => new Intl.ListFormat("en", { type: "conjunction" }).format(programs);
/** The search rules of the shell route (ARCH-TOOLS-052, PI-AGENT-053). */
const SEARCH = `On macOS and Linux, ${listed(SHELL_SEARCH_PROGRAMS)} stop after ${SEARCH_CPU_LIMIT_SECONDS}s of processing time with exit status 2 and advice to narrow the search, except ${listed(SHELL_SEARCH_PROGRAMS.filter((program) => SHELL_SEARCH_RULES[program].cpuLimitExemptWith.length > 0))} calls that run a command for each result. Their directory searches skip artifact directories such as node_modules and .git, and every directory that the repository's ignore rules exclude, unless a path argument names one; ${listed(SHELL_SEARCH_PROGRAMS.filter((program) => !SHELL_SEARCH_RULES[program].prunes))} skips nothing.`;
const WINDOWS_SEARCH = "On Windows, search file contents with the search tool, not with Get-ChildItem -Recurse piped to Select-String.";
const WRITE_ROOTS = "Keep writes inside the project, the .flywheel folders, and registered worktrees; the shell refuses the writes elsewhere that it recognizes.";
/** The file edit tool a request offers: `edit` for most models, `apply_patch`
 *  for the models whose contract is the freeform patch envelope. */
export type FileEditToolName = "edit" | "apply_patch";

/** The shell prompt names the edit tool the request actually offers. A model
 *  told to use "edit" when its tool is apply_patch looks for a tool that is
 *  not there and concludes it cannot edit files at all. It names only the
 *  file tools that the tree advertises. */
function tail(fileEditTool: FileEditToolName, has: CapabilityCheck): string {
  const tools = [...(has("edit") ? [fileEditTool] : []), ...(has("write") ? ["write"] : [])];
  const recorded = tools.length === 0 ? "" : ` These mutations are recorded like changes from the ${tools.join(" and ")} tool${tools.length > 1 ? "s" : ""}.`;
  return `${mutationGuidance(has)}${recorded}`;
}

/** The rule a read-only agent's task text states. The shell tools themselves
 *  read the same for every agent, so a read-only child shares their bytes in
 *  the prompt cache; execution enforces the rule. */
export const READ_ONLY_SHELL_GUIDANCE = "This agent is read-only: write only in its scratchpad or to device sinks. The shell refuses other writes and deletes that it recognizes.";

/** What one agent's shell offers. Every agent of a chat tree gets the same
 *  surface, because its shared engine host fixes the tool bytes at launch
 *  (ARCH-CONTEXT-018), so no field depends on the agent's persona or its own
 *  live selection. */
export interface BashSurfaceOptions {
  readonly fileEditTool?: FileEditToolName;
  /** False in a headless runtime: the schema has no `mutates` field and the
   *  description says nothing about mutating commands (PI-AGENT-119). */
  readonly mutatingDeclaration?: boolean;
  /** False when the person turned the shell write guard off: the description
   *  does not tell the agent about write roots (PI-AGENT-068). */
  readonly writeGuard?: boolean;
  /** False when the tree's capture holds no background shell contribution:
   *  the schema has no `background` or `persist_after_exit` field and the
   *  description says nothing about background launches. */
  readonly background?: boolean;
  /** False when the tree's captured policy disallows persistent processes:
   *  the schema has no `persist_after_exit` field (ARCH-TOOLS-034). */
  readonly persistence?: boolean;
  /** The tree check that decides which other tools the text names
   *  (ARCH-CONTEXT-033). Absent: every tool. */
  readonly has?: CapabilityCheck;
  /** True in an unattended chat, which no person reads (PI-AGENT-121): the description leaves out the commands that
   *  a person runs, the Detach control, and, off Windows, the Windows search rule. */
  readonly unattendedChat?: boolean;
  /** The platform that runs the commands. */
  readonly platform?: RuntimePlatform;
}

const EVERY_CAPABILITY: CapabilityCheck = () => true;

/** The shell tool's description carries the mechanics of running a command
 *  that no single field owns. `mutates` leads the schema so a call that
 *  mutates declares it before its command streams, and its row shows as an
 *  edit from the first bytes. A read-only agent sees `mutates`, and an agent
 *  whose own selection lacks what the tree advertises sees its fields;
 *  execution refuses each input the agent cannot use. The system prompt keeps only the
 *  output-preservation rule, which is a behavior contract rather than a
 *  description of the tool. */
export function bashToolSurface({ fileEditTool = "edit", mutatingDeclaration = true, writeGuard = true, background = true, persistence = true, has = EVERY_CAPABILITY, unattendedChat = false, platform = process.platform }: BashSurfaceOptions = {}): Pick<RuntimeTool, "description" | "promptGuidelines" | "inputSchema"> {
  const persists = background && persistence;
  const fields = commandProperties(background, persists);
  const windowsSearch = has("search") && (!unattendedChat || platform === "win32");
  return {
    description: [...(mutatingDeclaration ? [tail(fileEditTool, has)] : []), head(mutatingDeclaration, background, unattendedChat), background ? backgroundGuidance(unattendedChat) : foregroundOnly(unattendedChat), VENV, SCRATCH, ...(writeGuard ? [WRITE_ROOTS] : []), SEARCH, ...(windowsSearch ? [WINDOWS_SEARCH] : [])].join(" "),
    promptGuidelines: [SHELL_OUTPUT_GUIDANCE],
    inputSchema: {
      type: "object",
      properties: mutatingDeclaration
        ? { mutates: { type: "boolean", description: `${mutationGuidance(has)}${persists ? " Cannot be combined with persist_after_exit." : ""}` }, ...fields }
        : fields,
      required: ["command"],
    },
  };
}

