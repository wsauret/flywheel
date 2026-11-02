import { describe, expect, test } from "bun:test"
import { runtimeFaultCopy } from "../../../../src/protocol/client/runtime-fault-copy.js"
import { runtimeHealth } from "../../../../src/protocol/client/runtime-health.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../../src/protocol/runtime-liveness.js"

/** Words a notice never shows a person: internal names, ids, and measurements. */
const INTERNAL = /executor|paused|session [0-9a-f-]{8,}|heartbeat|lifecycle|channel/i

describe("runtime notice copy", () => {
  // The connection keeps reattaching while the fault shows, so the notice
  // says so first and names the reset only for a notice that stays.
  test("a lost runtime says that Flywheel keeps trying, then names the remedy for its lane", () => {
    expect(runtimeFaultCopy({ kind: "faulted", since: 1, cause: "Module services failed to settle" }, "installed")).toMatchObject({
      tone: "fault",
      title: "Flywheel's background service failed: Module services failed to settle",
      remedy: "Flywheel keeps trying to reach it. If this notice stays, run `flywheel kill`, then start Flywheel again.",
    })
  })

  // `flywheel kill` clears neither of these, so a notice that asked for it
  // would name a remedy that does not work.
  test("a start that an earlier release's empty claim holds names the claim, says that it clears itself, and asks for no reset", () => {
    const path = "/Users/me/.flywheel/serve/serve.start.lock.reclaim.9a77c488"
    const copy = runtimeFaultCopy({ kind: "faulted", since: 1, cause: "Failed to acquire lock 'serve.start.lock' after 9 attempts", refusal: { kind: "claim-settling", path } }, "installed")
    expect(copy).toMatchObject({
      tone: "warning",
      title: "Flywheel's background service is waiting to start: an earlier version of Flywheel left an empty start claim.",
      remedy: `The claim clears itself once it is 10 minutes old, and Flywheel can start after that. The claim is \`${path}\`.`,
    })
    expect(copy.remedy).not.toContain("flywheel kill")
  })

  test("a start that its address refuses names the address and says to fix its permissions or remove it, and asks for no reset", () => {
    const path = "/Users/me/.flywheel/serve/serve.sock"
    const copy = runtimeFaultCopy({ kind: "faulted", since: 1, cause: "the account service address answered EACCES to a connection", refusal: { kind: "address-access", path, code: "EACCES" } }, "dev")
    expect(copy).toMatchObject({
      tone: "fault",
      title: "Flywheel's background service could not start: its address refused this user's connection (EACCES).",
      remedy: `Fix the permissions of \`${path}\` so that you can connect to it, or remove the file. Flywheel can start after that.`,
    })
    expect(copy.remedy).not.toContain("flywheel kill")
  })

  // The program on the port can be an earlier Flywheel, which the lane's
  // reset ends, or another program, which the reset does not touch.
  test.each([
    ["installed", "Run `flywheel kill`, then start Flywheel again."],
    ["dev", "Run `flywheel kill dev`, then run `bun run dev` again."],
  ] as const)("a start whose hub port another program holds names the port, the %s lane's reset, and the command that names the program", (lane, reset) => {
    const copy = runtimeFaultCopy({ kind: "faulted", since: 1, cause: "Failed to start server. Is port 41000 in use?", refusal: { kind: "port-in-use", port: 41000 } }, lane)
    expect(copy).toMatchObject({
      tone: "fault",
      title: "Flywheel's background service could not start: another program uses port 41000.",
      remedy: `If that program is an earlier Flywheel: ${reset} Otherwise stop that program; \`lsof -nP -iTCP:41000 -sTCP:LISTEN\` names it (on Windows, \`netstat -ano | findstr :41000\`).`,
    })
  })

  test("a project a newer release saved names both state versions and the update, not the lane reset", () => {
    const copy = runtimeFaultCopy({ kind: "faulted", since: 1, cause: "project state is unavailable", refusal: { kind: "state-from-newer-release", stateEpoch: 99, readableEpoch: 2 } }, "installed")
    expect(copy).toMatchObject({
      tone: "fault",
      title: "Flywheel cannot open this project: a newer Flywheel release saved its state (state version 99; this release reads version 2).",
      remedy: "Update Flywheel with `flywheel update`, then open the project again.",
    })
  })

  // The protocol versions say which side is older, and only an older
  // client has something for the person to do.
  test("a runtime that refuses this client's protocol names its release, and asks for an update only when this client is the older one", () => {
    const newerRuntime = runtimeFaultCopy({ kind: "faulted", since: 1, cause: "refused", refusal: { kind: "protocol-mismatch", version: "0.3.0", protocolVersion: RUNTIME_PROTOCOL_VERSION + 1 } }, "installed")
    expect(newerRuntime).toMatchObject({
      tone: "fault",
      title: "This client is older than the Flywheel that runs this project (Flywheel 0.3.0).",
      remedy: "Update this client. It connects after that.",
    })
    const olderRuntime = runtimeFaultCopy({ kind: "faulted", since: 1, cause: "refused", refusal: { kind: "protocol-mismatch", version: "0.1.0", protocolVersion: RUNTIME_PROTOCOL_VERSION - 1 } }, "installed")
    expect(olderRuntime).toMatchObject({
      tone: "warning",
      title: "This project runs an earlier Flywheel (Flywheel 0.1.0) than this client.",
      remedy: "This client connects by itself once the project runs its release.",
    })
    // A refused attach ends no work, so the notice names no interrupted turn.
    for (const copy of [newerRuntime, olderRuntime]) {
      expect(copy.remedy).not.toContain("flywheel kill")
      expect(copy.detail).not.toContain("interrupted")
    }
  })

  // A terminal attached through the relay installs the machine's release
  // itself (PI-REMOTE-016), so the notice says what it is doing, or why it
  // could not, instead of asking the person to update.
  test("a remote machine on a later release says the terminal installs that release, and why it could not", () => {
    const refused = { kind: "faulted", since: 1, cause: "refused", refusal: { kind: "protocol-mismatch", version: "0.3.0", protocolVersion: RUNTIME_PROTOCOL_VERSION + 1 } } as const
    expect(runtimeFaultCopy(refused, { machine: "box", install: { status: "installing", version: "0.3.0" } })).toMatchObject({
      tone: "warning",
      title: "Flywheel on box runs a later release (Flywheel 0.3.0) than this terminal.",
      remedy: "Installing Flywheel 0.3.0 to match box. This terminal opens the project again after that.",
    })
    const reason = "Automatic updates are off, so Flywheel 0.3.0 was not installed. Turn them on in Flywheel settings, then open the project again."
    expect(runtimeFaultCopy(refused, { machine: "box", install: { status: "failed", version: "0.3.0", message: reason } })).toMatchObject({ tone: "fault", remedy: reason })
  })

  // A device that reaches the machine through the relay cannot run a
  // command on the machine, and a reset of its own machine ends nothing on
  // the remote one.
  test("a remote machine that does not answer names the machine, says that Flywheel keeps trying, and names no command", () => {
    expect(runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box", log: "~/.flywheel/machines/r1/p1/.flywheel/log" })).toEqual({
      tone: "fault",
      title: "Flywheel on box does not answer.",
      remedy: "Flywheel keeps trying to reach it. If this notice stays, make sure that box is awake and online, then open Flywheel on box.",
      detail: "If this keeps happening, the debug log at ~/.flywheel/machines/r1/p1/.flywheel/log has the details. A turn that was running opens interrupted; Resume or your next message continues it.",
    })
    expect(runtimeFaultCopy({ kind: "faulted", since: 1, cause: "the relay refused the attach" }, { machine: "box" })).toMatchObject({
      title: "Flywheel on box failed: the relay refused the attach",
      remedy: "Flywheel keeps trying to reach it. If this notice stays, make sure that box is awake and online, then open Flywheel on box.",
    })
  })

  test("a page with no log of its own names the machine's log", () => {
    expect(runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box" }).detail).toBe("If this keeps happening, the debug log at ~/.flywheel/log on box has the details. A turn that was running opens interrupted; Resume or your next message continues it.")
  })

  // The machine list says asleep at the same time, so the notice says the
  // same thing and not that a service stopped answering.
  test("a remote machine the relay reports offline says that it is asleep or offline and that Flywheel connects by itself", () => {
    expect(runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box", offline: true })).toMatchObject({
      tone: "fault",
      title: "box is asleep or offline.",
      remedy: "Wake it, or open Flywheel on it. Flywheel connects by itself after that.",
    })
  })

  // The machine list says the chosen project is asleep, starting, or could
  // not start, so the notice says the same thing and not that the machine
  // does not answer.
  test("a remote project the awake machine lists as not open says what its row says", () => {
    expect(runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box", offline: false, project: { name: "alpha", status: "asleep" } })).toMatchObject({
      tone: "fault",
      title: "alpha is asleep on box.",
      remedy: "Start it from the machine list. Flywheel connects by itself after that.",
    })
    expect(runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box", project: { name: "alpha", status: "starting" } })).toMatchObject({
      tone: "warning",
      title: "Flywheel is starting alpha on box.",
      remedy: "Flywheel connects by itself once alpha is open.",
    })
    expect(runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box", project: { name: "alpha", status: "failed" } })).toMatchObject({
      tone: "fault",
      title: "Flywheel could not start alpha on box.",
      remedy: "Try again from the machine list.",
    })
  })

  // The machine list shows the machine awake and no row for the chosen
  // project, so the notice says that, not that the machine does not answer
  // and must be woken.
  test("a remote project the awake machine does not list says that the machine does not offer it", () => {
    const copy = runtimeFaultCopy({ kind: "faulted", since: 1 }, { machine: "box", offline: false, project: { status: "unlisted" } })
    expect(copy).toMatchObject({
      tone: "fault",
      title: "box does not offer this project now.",
      remedy: "Open the project on box. Flywheel connects by itself after that.",
    })
    expect(`${copy.title} ${copy.remedy}`).not.toMatch(/does not answer|awake/)
  })

  test("a failed recovery on a remote machine names the reset on that machine and no surface of its own", () => {
    expect(runtimeFaultCopy({ kind: "recovery_failed", cause: "its saved history could not be repaired" }, { machine: "box" }).remedy).toBe("Open the project again. If that does not help, run `flywheel kill` on box, then open the project again.")
  })

  test("a process Flywheel is restarting names the recorded cause in user terms and asks nothing", () => {
    const copy = runtimeFaultCopy({ kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" }, "installed")
    expect(copy).toMatchObject({
      tone: "warning",
      title: "Flywheel's process for this project stopped again. Last cause: stopped by signal SIGKILL.",
      remedy: "Flywheel starts it again. Open sessions continue when it starts.",
    })
    expect(copy.remedy).not.toContain("flywheel kill")
    expect(`${copy.title} ${copy.remedy}`).not.toMatch(INTERNAL)
    expect(copy.detail).toContain("~/.flywheel/log")
  })

  test("a background service that keeps stopping soon after it starts names the recorded cause in user terms and asks nothing", () => {
    const copy = runtimeFaultCopy({ kind: "crash_loop", cause: "the account store cannot be opened\n    at open (store.ts:1:1)" }, "installed")
    expect(copy).toEqual({
      tone: "warning",
      title: "Flywheel's background service keeps stopping soon after it starts. Last cause: the account store cannot be opened.",
      remedy: "Flywheel starts it again. Open sessions continue when it starts.",
      detail: "If this keeps happening, the debug log at ~/.flywheel/log has the details. A turn that was running opens interrupted; Resume or your next message continues it.",
    })
    expect(`${copy.title} ${copy.remedy}`).not.toMatch(INTERNAL)
  })

  test("a failed recovery is a fault with the recorded cause and the lane's remedy", () => {
    const copy = runtimeFaultCopy({ kind: "recovery_failed", cause: "some commands it started did not stop" }, "dev")
    expect(copy).toMatchObject({
      tone: "fault",
      title: "Flywheel could not restore this project's sessions after its process stopped. Cause: some commands it started did not stop.",
      remedy: "Run `flywheel kill dev`, then run `bun run dev` again.",
    })
    expect(`${copy.title} ${copy.remedy}`).not.toMatch(INTERNAL)
  })

  test("a failed recovery states each failure class's own cause, never the title again, and no cause when none is known", () => {
    const title = "Flywheel could not restore this project's sessions after its process stopped."
    for (const cause of ["some commands it started did not stop", "its saved history could not be repaired", "the project's saved state could not be written"]) {
      const copy = runtimeFaultCopy({ kind: "recovery_failed", cause }, "installed")
      expect(copy.title).toBe(`${title} Cause: ${cause}.`)
      expect(copy.title.match(/could not restore/g)).toHaveLength(1)
      expect(copy.title).not.toMatch(INTERNAL)
    }
    expect(runtimeFaultCopy({ kind: "recovery_failed" }, "installed").title).toBe(title)
  })
})

describe("runtime health", () => {
  const SERVING = { kind: "serving" } as const
  const CRASH_LOOP = { kind: "crash_loop", cause: "the hub stopped" } as const

  test("a transport fault outranks what the runtime last said about its service and its process", () => {
    expect(runtimeHealth({ kind: "faulted", since: 4 }, CRASH_LOOP, { kind: "restarting", since: 1, cause: "stopped by signal SIGKILL" })).toEqual({ kind: "faulted", since: 4 })
  })

  test("a runtime that answers shows its process state, and nothing while it serves", () => {
    expect(runtimeHealth({ kind: "healthy" }, SERVING, { kind: "restarting", since: 1, cause: "exited with code 1" })).toEqual({ kind: "restarting", since: 1, cause: "exited with code 1" })
    expect(runtimeHealth({ kind: "healthy" }, SERVING, { kind: "recovery_failed", cause: "its saved history could not be repaired" })).toEqual({ kind: "recovery_failed", cause: "its saved history could not be repaired" })
    expect(runtimeHealth({ kind: "healthy" }, SERVING, SERVING)).toEqual({ kind: "healthy" })
  })

  test("a background service that keeps stopping outranks a project process that Flywheel starts again", () => {
    expect(runtimeHealth({ kind: "healthy" }, CRASH_LOOP, { kind: "restarting", since: 1, cause: "exited with code 1" })).toEqual(CRASH_LOOP)
    expect(runtimeHealth({ kind: "healthy" }, CRASH_LOOP, SERVING)).toEqual(CRASH_LOOP)
  })

  test("sessions that could not be restored outrank a background service that keeps stopping, because only they ask the person to act", () => {
    expect(runtimeHealth({ kind: "healthy" }, CRASH_LOOP, { kind: "recovery_failed", cause: "its saved history could not be repaired" })).toEqual({ kind: "recovery_failed", cause: "its saved history could not be repaired" })
  })
})
