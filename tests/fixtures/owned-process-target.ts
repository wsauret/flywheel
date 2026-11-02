import { existsSync, writeFileSync } from "node:fs"

/** A real payload for owned-subprocess tests.
 *
 *  It writes its pid to the marker path as its first act, so the marker's
 *  existence is proof the payload actually ran - that is what the pre-exec
 *  ownership barrier must prevent when ownership is refused.
 *
 *  Usage: owned-process-target.ts <marker> [--stubborn] [--graceful] [--grandchild] [--exit]
 *  --stubborn   ignore SIGTERM, so only a group SIGKILL ends it
 *  --graceful   answer SIGTERM by writing `<marker>.term` and exiting 0
 *  --grandchild spawn a stubborn child inside the same container
 *  --exit       exit as soon as the marker is written, which leaves any
 *               grandchild holding a container whose leader is already gone */

const marker = process.argv[2]
if (!marker) throw new Error("owned-process-target requires a marker path")
const flags = new Set(process.argv.slice(3))

if (flags.has("--stubborn")) process.on("SIGTERM", () => {})
if (flags.has("--graceful")) {
  process.on("SIGTERM", () => {
    writeFileSync(`${marker}.term`, "term")
    process.exit(0)
  })
}

writeFileSync(marker, String(process.pid))

const grandchild = `${marker}.grandchild`
if (flags.has("--grandchild")) {
  Bun.spawn([process.execPath, import.meta.path, grandchild, "--stubborn"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
}

if (flags.has("--exit")) {
  // The point of exiting is to leave a descendant holding the container, so
  // the descendant has to be running before this process goes. A spawn only
  // requests a process; the marker is the descendant saying it arrived.
  if (flags.has("--grandchild")) {
    const deadline = Date.now() + 10_000
    while (!existsSync(grandchild)) {
      if (Date.now() >= deadline) throw new Error("the grandchild never started")
      await Bun.sleep(10)
    }
  }
  process.exit(7)
}

setInterval(() => {}, 1_000)
