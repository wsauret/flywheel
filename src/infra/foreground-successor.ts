/** The bounded terminal-successor authority.
 *
 *  A terminal that follows a protocol change replaces its own process image
 *  with the build that serves (ARCH-RUNTIME-036). Where the platform cannot replace a
 *  process image, which is Windows, the successor runs as this process's
 *  child instead, and it must be what an ordinary launch never is: a member
 *  of the shell's foreground job that reads and writes the terminal itself. An
 *  owned launch is a container in its own process group with piped streams,
 *  so this one launch stays raw, and this module holds nothing else. The
 *  predecessor stays alive only as the job the shell waits on. */

/** Runs the successor with this process's terminal streams in this process's
 *  foreground job, and answers its exit status once it ends. Throws when the
 *  successor cannot start. */
export async function runForegroundSuccessor(command: readonly string[], env: { readonly [name: string]: string | undefined }): Promise<number> {
  const successor = Bun.spawn([...command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...env },
    // The successor attaches to this process's console; no window of its own.
    windowsHide: true,
  })
  return await successor.exited
}
