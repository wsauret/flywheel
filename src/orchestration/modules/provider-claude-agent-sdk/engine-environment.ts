import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { EngineHost } from "../../../infra/claude-engine.js";

/** The machine reads that the engine's Git Bash rule makes. Tests replace it. */
export interface ShellProbe {
  exists(path: string): boolean;
  /** The path of `command` on `path`, the PATH variable, or null when it is not there. */
  which(command: string, path: string | undefined): string | null;
}

const machineProbe: ShellProbe = {
  exists: existsSync,
  which: (command, path) => Bun.which(command, path === undefined ? {} : { PATH: path }),
};

/** Where Git for Windows installs its bash when the engine finds no `git` on the PATH. */
const FIXED_GIT_BASH_PATHS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"] as const;

/**
 * The shell that the engine on `host` names in its environment snapshot, or undefined where it names the shell of the
 * canonical environment reminder (`environmentFacts`), which is every host but Windows. The engine compares its live
 * snapshot with the newest one in its conversation and states a whole new environment block when the shells differ,
 * so every environment row that Flywheel writes for the engine states this shell, and each request states the
 * environment once. Canonical history keeps PowerShell on Windows, which names the shell that Flywheel's shell tool
 * runs.
 *
 * On Windows the engine names "bash" when it finds Git Bash and "PowerShell" when it does not. This is a copy of the
 * engine's own rule (CLI 2.1.306): the two fixed install paths, then `..\..\bin\bash.exe` beside the `git` that the
 * engine's PATH finds, which is the host PATH (cli-environment.ts). The engine reads `CLAUDE_CODE_GIT_BASH_PATH` first
 * and switches its shell with `CLAUDE_CODE_USE_POWERSHELL_TOOL`, but Flywheel passes it no `CLAUDE_*` variable, so
 * neither applies. The engine reads the rule at each start, so this reads it at each call.
 */
export function engineShell(host: Pick<EngineHost, "platform" | "hostEnvironment">, probe: ShellProbe = machineProbe): string | undefined {
  if (host.platform !== "win32") return undefined;
  if (FIXED_GIT_BASH_PATHS.some((path) => probe.exists(path))) return "bash";
  const git = probe.which("git", host.hostEnvironment["PATH"]);
  return git !== null && probe.exists(win32.join(git, "..", "..", "bin", "bash.exe")) ? "bash" : "PowerShell";
}
