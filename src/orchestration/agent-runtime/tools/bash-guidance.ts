import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { RuntimePlatform } from "./bash-script.js";
import { SEARCH_CPU_LIMIT_SECONDS, SHELL_SEARCH_PROGRAMS, SHELL_SEARCH_RULES, type ShellSearchProgram } from "./search-rules.js";
import type { RuntimeTool } from "./types.js";

const SHELL_OUTPUT_GUIDANCE = "Preserve live command output: the runtime captures stdout and stderr. Never redirect, suppress, filter, or capture diagnostic output with `>`, `>>`, `2>`, `2>&1`, `&>`, `/dev/null`, or log-filtering pipes. Redirect stdout only when stdout is the requested file artifact. Read the output of a command in managed execution with process read_output or its completion notification.";

const mutationGuidance = (recordedLike: string, has: CapabilityCheck): string => {
  const scripts = has("write") ? " Create files to run, such as scratch scripts, with the write tool; bash only runs them." : "";
  return `Git commands that change the repository are refused inside mutates: true; run them as a separate call without mutates. Commands that only read Git, including scripts that only read Git, are allowed. Set mutates: true only when the command's purpose is to change the project files you are working on, so that its changes are recorded like ${recordedLike}. Examples: heredoc and cat > writes, sed -i, Python or Bun scripts that rewrite files, formatters, code generators, and plain mv and rm. Leave it unset when the writes are side effects of running something: installing dependencies or binaries, builds, tests, caches, and servers. Write this field first, before command. Use relative project paths: the command runs in a private copy, and only its changes to file contents land when it exits. Processes it starts can end when it exits, so start servers and watchers in a separate call without mutates.${scripts}`;
};

const timeoutGuidance = (background: boolean): string => `Optional hard deadline in seconds, at most 3600. Set it only when the command must stop by then. ${background ? "It also binds a background command, stays active after a transfer to managed execution, and ends the process group." : "It stays active after a transfer to managed execution and ends the process group."}`;

/** The fields of a bash schema after `mutates`, in order. Timeout and
 *  persistence rules live on their fields. */
const commandProperties = (background: boolean, persistence: boolean, mutatingDeclaration: boolean) => ({
  command: { type: "string" },
  cwd: { type: "string", description: "Default: project root." },
  timeout: { type: "number", description: timeoutGuidance(background) },
  ...(background ? { background: { type: "boolean", description: "Run the command as a managed background process." } } : {}),
  ...(persistence ? { persist_after_exit: { type: "boolean", description: `Let this background command outlive the runtime, such as a server that must keep running after you stop waiting. The runtime can inspect and stop it only until it exits. Requires background=true; cannot be combined with timeout${mutatingDeclaration ? " or mutates" : ""}.` } } : {}),
  raw_output: { type: "boolean", description: "Skip output compression for this call. Without it, a long bun test run drops passing-test lines, and other output over about 28,000 bytes keeps its head, its tail, and its error and warning lines. The result marks each cut and names the file with the full output. Prefer streaming and chunked processing over loading everything into memory." },
});

const headStart = (platform: RuntimePlatform) => `Execute a shell command in a fresh process: environment variables, the working directory, and shell state do not persist between calls. Commands run in ${platform === "win32" ? "PowerShell" : "bash"}. Set the working directory with cwd, not cd. Quote paths that contain spaces or special characters. Chain dependent commands with && or ; in one call`;
const headEnd = (background: boolean) => `. A command that reads typed input, such as a password or a confirmation prompt, or a login that asks for a code at the prompt, belongs to the person: ${background ? "never start it in the background, and ask" : "ask"} the person to run it. A login that only waits for a browser, such as \`aws sso login\` or another SSO or device-code flow, reads no typed input: run it yourself in the foreground, and first tell the person to complete it in the browser.`;
// The commands that a person runs at the prompt or in a browser have no reader in an unattended chat.
const head = (platform: RuntimePlatform, background: boolean, unattendedChat: boolean) => `${headStart(platform)}${unattendedChat ? "." : headEnd(background)}`;
const STOP_BY_ID = "Stop a process by its process-tool id or exact PID, never by a name pattern.";
/** How long a finite foreground command stays in its tool call, as every shell text that the model reads states it.
 *  A timeout does not keep a command in its call past the runtime cap. Detach is a client control, which an
 *  unattended chat has no person to select (PI-AGENT-121). */
export const foregroundCommandLifetime = (unattendedChat: boolean): string => unattendedChat
  ? "A foreground command moves to managed execution when it reaches the runtime cap; wait for it with the process tool."
  : "A foreground command moves to managed execution when you select Detach or it reaches the runtime cap; wait for it with the process tool.";
const backgroundGuidance = (unattendedChat: boolean): string => `Set background: true for a long command when you can do other work while it runs, or for a server; never use shell-level &, nohup, or disown. A background command keeps the session working until it ends or is stopped, so stop a server that you no longer need. A managed background command ends when its runtime exits. ${foregroundCommandLifetime(unattendedChat)} Wait for a background command the same way. ${STOP_BY_ID}`;
const foregroundOnly = (unattendedChat: boolean): string => `Never use shell-level &, nohup, or disown. ${foregroundCommandLifetime(unattendedChat)} ${STOP_BY_ID}`;
const VENV = "A Python virtualenv activation does not persist: call venv/bin/python directly.";
const SCRATCH = "Scratch scripts are a normal way to work: put them and their outputs in the scratchpad directory. `bun` is always on PATH.";
const listed = (programs: readonly ShellSearchProgram[]): string => new Intl.ListFormat("en", { type: "conjunction" }).format(programs);
/** The search rules of the shell route (ARCH-TOOLS-052, PI-AGENT-053). */
const SEARCH = `On macOS and Linux, ${listed(SHELL_SEARCH_PROGRAMS)} stop after ${SEARCH_CPU_LIMIT_SECONDS}s of processing time with exit status 2 and advice to narrow the search, except ${listed(SHELL_SEARCH_PROGRAMS.filter((program) => SHELL_SEARCH_RULES[program].cpuLimitExemptWith.length > 0))} calls that run a command for each result. They skip artifact and ignored directories unless a path names one, but ${listed(SHELL_SEARCH_PROGRAMS.filter((program) => !SHELL_SEARCH_RULES[program].prunes))} skips nothing.`;
const WINDOWS_SEARCH = "On Windows, search file contents with the search tool, not with Get-ChildItem -Recurse piped to Select-String.";
const WRITE_ROOTS = "Keep writes inside the project, the .flywheel folders, and registered worktrees; the shell refuses the writes elsewhere that it recognizes.";
/** The file edit tool a request offers: `edit` for most models, `apply_patch`
 *  for the models whose contract is the freeform patch envelope. */
export type FileEditToolName = "edit" | "apply_patch";

/** The `mutates` field is the one home of the mutation rule (ARCH-CONTEXT-035). It names the edit tool the request
 *  actually offers: a model told to use "edit" when its tool is apply_patch looks for a tool that is not there and
 *  concludes it cannot edit files at all. It names only the file tools that the tree advertises. */
function mutatesDescription(fileEditTool: FileEditToolName, has: CapabilityCheck): string {
  const tools = [...(has("edit") ? [fileEditTool] : []), ...(has("write") ? ["write"] : [])];
  const recordedLike = tools.length === 0 ? "a file edit" : `changes from the ${tools.join(" and ")} tool${tools.length > 1 ? "s" : ""}`;
  return mutationGuidance(recordedLike, has);
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
   *  a person runs and the Detach control. */
  readonly unattendedChat?: boolean;
  /** The platform that runs the commands. It names the one shell and the search rules of that platform; every
   *  agent of a tree shares one host, so the bytes stay identical across the tree (ARCH-CONTEXT-018). */
  readonly platform?: RuntimePlatform;
}

const EVERY_CAPABILITY: CapabilityCheck = () => true;

/** Flywheel's file-work policy: the shell and the file tools are equal routes, and the file tools are the safer one
 *  for an edit that the shell does badly. Undefined when the request has neither file-changing tool. */
function fileWorkGuidance(fileEditTool: FileEditToolName, has: CapabilityCheck): string | undefined {
  const tools = [...(has("edit") ? [fileEditTool] : []), ...(has("write") ? ["write"] : [])].map((tool) => `\`${tool}\``);
  if (tools.length === 0) return undefined;
  return `For reading, searching, and changing files, the shell and the file tools are equal routes. Use the simpler one. Use ${tools.join(" or ")} when a shell edit is fragile: an exact or multi-line replacement, text that needs heavy quoting, or \`sed\` options that behave differently on macOS and Linux.`;
}

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
  const fields = commandProperties(background, persists, mutatingDeclaration);
  const searchRules = platform !== "win32" ? [SEARCH] : has("search") ? [WINDOWS_SEARCH] : [];
  return {
    description: [head(platform, background, unattendedChat), background ? backgroundGuidance(unattendedChat) : foregroundOnly(unattendedChat), VENV, SCRATCH, ...(writeGuard ? [WRITE_ROOTS] : []), ...searchRules].join(" "),
    promptGuidelines: [SHELL_OUTPUT_GUIDANCE, ...[fileWorkGuidance(fileEditTool, has)].filter((line) => line !== undefined)],
    inputSchema: {
      type: "object",
      properties: mutatingDeclaration
        ? { mutates: { type: "boolean", description: mutatesDescription(fileEditTool, has) }, ...fields }
        : fields,
      required: ["command"],
    },
  };
}

