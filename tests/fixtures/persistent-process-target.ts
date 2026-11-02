import { writeFileSync } from "node:fs"

import { launchPersistentSubprocess } from "../../src/infra/persistent-subprocess.js"
import { unixProcessIdentity, windowsProcessIdentity } from "../../src/infra/process-container.js"

const [mode, directory, owner] = process.argv.slice(2)
if (!mode || !directory || !owner) throw new Error("persistent-process-target requires a mode, a fixture directory, and the owner's pid")

const file = (name: string): string => `${directory}/${name}`

/** Ends this process once its owner, the test process named in argv, is
 *  proven gone or replaced.
 *
 *  A released payload outlives its launcher on purpose, so a test runner that
 *  is killed before its cleanup runs leaves the payload, its descendant, and a
 *  launcher that waits to be signalled with nobody to end them. Only proof
 *  ends them, as SVC-1 asks of the product: a probe that does not answer keeps
 *  the process running and asks again. The watch holds no event loop open, so
 *  a mode that finishes its own work still exits on its own terms. */
function endWithOwner(pid: number): void {
  const identify = process.platform === "win32" ? windowsProcessIdentity : unixProcessIdentity
  const bound = identify(pid)
  // An owner that cannot be identified now could never be proven gone later.
  if (bound.kind !== "process") throw new Error(`persistent-process-target cannot identify its owner ${pid}: ${bound.kind}`)
  setInterval(() => {
    const current = identify(pid)
    if (current.kind === "absent" || (current.kind === "process" && current.identity !== bound.identity)) process.exit(0)
  }, 250).unref()
}

endWithOwner(Number(owner))

if (mode === "payload") {
  writeFileSync(file("payload.pid"), String(process.pid))
  const descendant = Bun.spawn([process.execPath, import.meta.path, "descendant", directory, owner], {
    stdin: "ignore",
    // Not inherited: this payload is launched detached, so by the time it starts
    // a child of its own the streams it would pass on are already closed, and
    // the launch fails with ERROR_NO_DATA. Windows then opens a console window
    // to show that failure, which outlives the test that caused it.
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  writeFileSync(file("descendant.pid"), String(descendant.pid))
  let tick = 0
  setInterval(() => {
    process.stdout.write(`stdout-${tick}\n`)
    process.stderr.write(`stderr-${tick}\n`)
    tick += 1
  }, 20)
} else if (mode === "immediate") {
  process.exit(23)
} else if (mode === "descendant") {
  setInterval(() => {
    process.stdout.write("descendant-stdout\n")
    process.stderr.write("descendant-stderr\n")
  }, 20)
} else if (mode === "launch-exit" || mode === "launch-sigterm" || mode === "launch-sigkill") {
  const child = await launchPersistentSubprocess([process.execPath, import.meta.path, "payload", directory, owner])
  writeFileSync(file("launch.json"), JSON.stringify({ pid: child.pid, spool: child.spool }))
  child.release()
  if (mode !== "launch-exit") {
    if (mode === "launch-sigterm") process.on("SIGTERM", () => process.exit(0))
    writeFileSync(file("launcher-ready"), String(process.pid))
    setInterval(() => {}, 1_000)
  }
} else {
  throw new Error(`unknown persistent process target mode: ${mode}`)
}
