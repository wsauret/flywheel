/** How to launch one command line through the platform shell. */
export interface ShellCommandLaunch {
  readonly argv: readonly string[]
  /** The launch environment, when the command travels in it. Otherwise the
   *  launch inherits this process's environment. */
  readonly env?: { readonly [key: string]: string | undefined }
}

const WINDOWS_COMMAND_VARIABLE = "FLYWHEEL_SHELL_COMMAND"

/** Launches a command line the person wrote, such as a configured helper, with
 *  its quotes, pipes, and redirects read by the shell: `sh -c` on POSIX and
 *  `cmd /d /s /c` on Windows.
 *
 *  On Windows the command cannot travel as an argument. Bun quotes each `"`
 *  inside an argument as `\"`, which cmd does not read, so a command such as
 *  `"C:\Program Files\x\op.exe" read "op://vault/key"` would reach cmd broken.
 *  cmd expands a variable before it parses the line, so the command goes in
 *  through the environment and keeps every quote. */
export function shellCommandLaunch(command: string): ShellCommandLaunch {
  if (process.platform !== "win32") return { argv: ["sh", "-c", command] }
  return {
    argv: [process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", `%${WINDOWS_COMMAND_VARIABLE}%`],
    env: { ...process.env, [WINDOWS_COMMAND_VARIABLE]: command },
  }
}
