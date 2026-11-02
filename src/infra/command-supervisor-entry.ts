import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { flywheelCacheDirectory, runsThroughBun } from "./cli-subprocess.js"
import { errorMessage } from "./error-message.js"
import { EXECUTABLE_ROLES } from "./executable-roles.js"

/** Which code a launch of the command supervisor runs.
 *
 *  A packaged binary re-enters itself with the role marker, so the supervisor
 *  it starts is the code it already runs. A source checkout starts the
 *  supervisor module through Bun, from a locked snapshot once one exists. */

/** What locking the supervisor entry produced. `packaged` means there was
 *  nothing to lock: a packaged binary re-enters itself, so the supervisor it
 *  spawns is already the code it runs. */
export type CommandSupervisorLock =
  | { readonly kind: "locked"; readonly path: string }
  | { readonly kind: "packaged" }
  | { readonly kind: "failed"; readonly reason: string }

let lockedEntry: string | undefined
let locking: Promise<CommandSupervisorLock> | undefined

/** Locks the supervisor code this process spawns, so edits to the working tree
 *  cannot change or break later launches.
 *
 *  A source checkout that spawned the live module would re-read the whole
 *  module graph from disk on every launch, so a checkout left unparseable in
 *  the middle of an edit would fail every later shell command in every running
 *  session. The lock bundles the graph once, into a snapshot, and every later
 *  launch enters through that snapshot.
 *
 *  The snapshot is split: code a supervisor loads only when it needs it, such
 *  as the live-build registry a handed-over supervisor holds, is a chunk of
 *  its own that only that supervisor reads, so no other launch parses it.
 *  Every file is named by a hash of its content and lives in the checkout's
 *  own build cache, not in the temporary directory and not in the source
 *  snapshot a dev service runs from. Equal content is equal code, so every
 *  process and Worker of one checkout shares one set of files, and a
 *  process that is killed leaves nothing new behind. An edit to the
 *  graph makes new files beside the old ones, which a process that still runs
 *  the old code keeps using.
 *
 *  Idempotent: repeated calls join the first. A failed lock leaves launches on
 *  the live module, which is the pre-lock behavior; the caller decides how
 *  loudly to report that. */
export function lockCommandSupervisorEntry(): Promise<CommandSupervisorLock> {
  if (!runsThroughBun(process.execPath)) return Promise.resolve({ kind: "packaged" })
  locking ??= snapshotSupervisorModule()
  return locking
}

async function snapshotSupervisorModule(): Promise<CommandSupervisorLock> {
  try {
    const built = await Bun.build({ entrypoints: [liveSupervisorModule()], target: "bun", splitting: true })
    const entry = built.outputs.find((output) => output.kind === "entry-point")
    if (!built.success || entry === undefined) throw new Error(built.logs.map(String).join("; ") || "the bundler produced no output")
    const directory = flywheelCacheDirectory()
    fs.mkdirSync(directory, { recursive: true })
    // Chunks first, so an entry never names a chunk that is not there yet. The
    // bundler names each chunk by its content, and the entry names every chunk
    // it loads, so the entry's own digest covers the whole snapshot.
    for (const chunk of built.outputs) {
      if (chunk !== entry) writeOnce(join(directory, basename(chunk.path)), await chunk.text())
    }
    const code = await entry.text()
    const digest = new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 16)
    const outfile = join(directory, `owned-command-supervisor-${digest}.js`)
    writeOnce(outfile, code)
    lockedEntry = outfile
    return { kind: "locked", path: outfile }
  } catch (err) {
    return { kind: "failed", reason: errorMessage(err) }
  }
}

/** Writes a content-named file unless it is already there. Another process
 *  can write the same file at the same time. Each writes its own file and
 *  renames it into place, so a reader never sees a partial one, and the last
 *  rename replaces equal bytes. */
function writeOnce(file: string, code: string): void {
  if (fs.existsSync(file)) return
  const partial = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  fs.writeFileSync(partial, code)
  fs.renameSync(partial, file)
}

function liveSupervisorModule(): string {
  return fileURLToPath(new URL("owned-command-supervisor.ts", import.meta.url))
}

/** The start of a supervisor's argv: the executable and what it enters.
 *  Linux re-enters the running executable through its process identity so
 *  installation-path replacement cannot break later launches. A source
 *  checkout runs the locked snapshot when one exists and the live module
 *  before the lock lands; a packaged binary has no module path, so it
 *  re-enters itself with the role marker. */
export function commandSupervisorEntry(): readonly string[] {
  const executable = process.platform === "linux" ? "/proc/self/exe" : process.execPath
  return runsThroughBun(process.execPath)
    ? [executable, lockedEntry ?? liveSupervisorModule()]
    : [executable, EXECUTABLE_ROLES.commandSupervisor]
}
