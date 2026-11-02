/** Payloads for tests that need a real process, named by what the test needs
 *  from them rather than by the shell script that produces it.
 *
 *  A test about container ownership does not care whether a process runs
 *  `sleep` or `ping`; it cares that something is alive until the container ends
 *  it. Writing the POSIX script inline made every such test POSIX-only, which
 *  is why these are intents: each one states what the process does, and each
 *  platform answers with its own way of doing it. */

const WINDOWS_SHELL = process.env.ComSpec ?? "cmd.exe"
const POSIX_SHELL = "/bin/sh"

/** A process that stays alive until something ends it.
 *
 *  Neither form writes anything: a payload whose output nobody drains would
 *  block on a full pipe, and a test that then waited for it to exit would wait
 *  for a deadlock rather than for the behavior it is checking. */
export function payloadThatRunsForever(): readonly string[] {
  // `ping` against the loopback with an enormous count is the Windows idiom for
  // a bounded-command sleep: `timeout` reads the console, which a payload with
  // redirected input does not have.
  return process.platform === "win32"
    ? [WINDOWS_SHELL, "/d", "/s", "/c", "ping -n 99999 127.0.0.1 >nul"]
    : [POSIX_SHELL, "-c", "sleep 60"]
}

/** A process that exits immediately with `code`. */
export function payloadThatExits(code = 0): readonly string[] {
  return process.platform === "win32"
    ? [WINDOWS_SHELL, "/d", "/s", "/c", `exit ${code}`]
    : [POSIX_SHELL, "-c", `exit ${code}`]
}

/** A process that writes `text` to standard output and exits. */
export function payloadThatPrints(text: string): readonly string[] {
  return process.platform === "win32"
    // `echo` without a redirect adds a line ending on both platforms; the
    // callers here compare trimmed output.
    ? [WINDOWS_SHELL, "/d", "/s", "/c", `echo ${text}`]
    : [POSIX_SHELL, "-c", `printf %s ${text}`]
}

/** A process that writes to both streams and exits with `code`, so a test can
 *  tell the two streams apart and still read the status. */
export function payloadThatWritesBothStreams(out: string, err: string, code: number): readonly string[] {
  return process.platform === "win32"
    ? [WINDOWS_SHELL, "/d", "/s", "/c", `echo ${out}& echo ${err} 1>&2& exit ${code}`]
    : [POSIX_SHELL, "-c", `echo ${out}; echo ${err} >&2; exit ${code}`]
}

/** A process that creates `file` and then stays alive, so a test can wait for
 *  proof that the payload really started before it asserts anything. */
export function payloadThatSignalsThenRunsForever(file: string): readonly string[] {
  return process.platform === "win32"
    ? [WINDOWS_SHELL, "/d", "/s", "/c", `echo started>"${file}" & ping -n 99999 127.0.0.1 >nul`]
    : [POSIX_SHELL, "-c", `echo started > '${file}'; sleep 60`]
}
