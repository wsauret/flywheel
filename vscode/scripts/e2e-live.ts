/**
 * Drives the real client stack against a real runtime.
 *
 * Everything else in this repository tests a layer against a fixture. This runs
 * the shipped supervisor, connection, ordered intake, transcript store, and
 * session controller against an account service that is actually serving, in a
 * throwaway project, and reports what arrived.
 *
 * It does not need a usable model. A terminal assistant message or a rendered
 * provider failure proves mutation dispatch, session creation, cursor seeding,
 * live output intake, and transcript settlement through the same client stack.
 *
 * It owns exactly one process and stops that one by pid. That service runs
 * through bun, so it serves the dev lane, which is never resident: it retires
 * one second after nothing holds it. The script keeps its first attach open
 * for the whole run, as an open editor keeps its connection, so the service
 * stays up while a later request waits, such as the first `client` request,
 * which builds the client before it answers and holds nothing meanwhile.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redacted } from "effect"

import { createRuntimeConnection } from "../../src/protocol/client/connection.js"
import { nodeSocketLayer } from "../src/runtime/node-socket.js"
import { SocketBridge } from "../src/webview/socket-bridge.js"
import { ViewBridge, postMessageSocketLayer } from "../../webview/editor/post-message-socket.js"
import { createRuntimeSession } from "../../webview/src/client/session.js"
import { resolveEditorClient } from "../src/runtime/editor-client.js"
import { prepareAccountRuntime } from "../src/runtime/supervisor.js"
import { liveTransportVerdict, observeLiveBlocks } from "./e2e-live-verdict.js"

const REPOSITORY_ROOT = join(import.meta.dir, "..", "..")

/** The executable the supervisor asks its version. Windows cannot run the
 *  checkout's shell launcher that way, so there it builds this checkout's flat
 *  Windows build and asks that. */
function defaultFlywheel(): string {
  if (process.platform !== "win32") return join(REPOSITORY_ROOT, "bin", "flywheel")
  const build = Bun.spawnSync(["bun", "run", "scripts/build-binary.ts"], { cwd: REPOSITORY_ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
  return join(REPOSITORY_ROOT, "dist", `flywheel-win32-${process.arch}`, "flywheel.exe")
}

const FLYWHEEL = process.env.FLYWHEEL_BIN ?? defaultFlywheel()
const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-e2e-"))
const nativeProjectRoot = mkdtempSync(join(tmpdir(), "flywheel-e2e-native-"))
const bridgeProjectRoot = mkdtempSync(join(tmpdir(), "flywheel-e2e-bridge-"))
const accountHome = mkdtempSync(join(tmpdir(), "flywheel-e2e-account-"))

const say = (line: string) => writeSync(1, `${line}\n`)
const step = (name: string, detail = "") => say(`  ${name.padEnd(34)} ${detail}`)
let accountProcess: ChildProcess | undefined
let connection: ReturnType<typeof createRuntimeConnection> | undefined
let nativeConnection: ReturnType<typeof createRuntimeConnection> | undefined

const settled = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

async function stopOwnedRuntime(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve())
  })
  child.kill()
  const stopped = await Promise.race([closed.then(() => true), settled(5_000).then(() => false)])
  if (stopped) return
  child.kill("SIGKILL")
  await Promise.race([closed, settled(3_000)])
}

try {
  say(`\nproject ${projectRoot}\n`)

  const account = await prepareAccountRuntime({
    executable: FLYWHEEL,
    projectRoot,
    accountHome,
    minimumVersion: "0.0.4",
    // The harness is the service itself, so this script owns and stops it.
    spawnProcess: (_executable, _args, options) => {
      accountProcess = spawn(process.execPath, [
        "run",
        join(import.meta.dir, "..", "..", "tests", "integration", "local", "_vscode-account-service.ts"),
      ], options)
      return accountProcess
    },
  })
  if (!account.ok) {
    console.error("account service did not start:", JSON.stringify(account.failure))
    process.exit(1)
  }
  const accountTarget = {
    ...account.target,
    credential: Redacted.value(account.target.credential),
  }
  nativeConnection = createRuntimeConnection({ socket: nodeSocketLayer({ ...accountTarget, projectRoot: nativeProjectRoot }) })
  const nativeSnapshot = await nativeConnection.query({ type: "snapshot" })
  step("serve native read", nativeSnapshot.projectRoot)

  // The editor mounts the client the runtime names, so the script asks the
  // way the chat view does and proves the named directory holds the bundle.
  const bundle = await resolveEditorClient(accountTarget)
  for (const file of ["webview.js", "webview.css"]) {
    if (!existsSync(join(bundle.dir, file))) throw new Error(`the runtime named ${bundle.dir} as its editor client, and ${file} is not there`)
  }
  step("editor client", `${bundle.dir} (${bundle.identity.slice(0, 12)})`)

  // The editor's page offers the identity the `client` answer named, over the
  // extension's byte pump, exactly as the mounted client does.
  const socketBridge = new SocketBridge({ ...accountTarget, projectRoot: bridgeProjectRoot }, (message) => { viewBridge.handle(message) })
  const viewBridge = new ViewBridge((message) => socketBridge.handle(message))
  const bridgeConnection = createRuntimeConnection({ socket: postMessageSocketLayer(viewBridge), clientIdentity: bundle.identity })
  const bridgeSnapshot = await bridgeConnection.query({ type: "snapshot" })
  step("serve bridge read", bridgeSnapshot.projectRoot)
  await bridgeConnection.close()
  socketBridge.dispose()
  if (nativeSnapshot.projectRoot === bridgeSnapshot.projectRoot) {
    throw new Error("account service routed distinct editor targets to one project")
  }

  // A page built for another runtime is refused at its event attach, inside
  // the protocol: the connection reports the mismatch once and never reports
  // the runtime as connected.
  const staleOutcome = Promise.withResolvers<void>()
  const staleConnection = createRuntimeConnection({
    socket: nodeSocketLayer({ ...accountTarget, projectRoot: bridgeProjectRoot }),
    clientIdentity: "0".repeat(64),
    onClientMismatch: () => { staleOutcome.resolve() },
  })
  staleConnection.subscribe(() => {})
  staleConnection.onLane(() => { staleOutcome.reject(new Error("the runtime admitted a stale client identity")) })
  await Promise.race([
    staleOutcome.promise,
    settled(15_000).then(() => { throw new Error("the runtime neither refused nor admitted a stale client identity within 15s") }),
  ])
  step("stale client refused", "client-mismatch at the event attach")

  connection = createRuntimeConnection({ socket: nodeSocketLayer(accountTarget), clientIdentity: bundle.identity })

  connection.subscribe(() => {})
  const attached = new Promise<number>((resolve) => { connection!.onLane(resolve) })
  step("event lane", `lane ${await attached} open`)

  const snapshot = await connection.query({ type: "snapshot" })
  step("snapshot", `projectRoot=${snapshot.projectRoot} sessions=${snapshot.rows.length}`)

  const session = createRuntimeSession({ connection })
  await settled(500)

  await session.openNew()
  await settled(1500)
  step("session opened", session.sessionId ?? "(none)")

  const transcript = session.transcript
  if (!transcript) {
    console.error("no transcript store for the opened session")
    process.exit(1)
  }
  step("transcript status", transcript.status)

  await session.send("Transport smoke probe.")

  // Watch the store rather than the wire: what this is checking is that ordered
  // intake and delta application put blocks into the resident window.
  type Block = (typeof transcript.view.blocks)[number]
  const seen = new Map<string, Block>()
  const deadline = Date.now() + 25_000
  let verdict = liveTransportVerdict([], session.activity, connection.state)
  while (Date.now() < deadline) {
    observeLiveBlocks(seen, transcript.view.blocks)
    verdict = liveTransportVerdict([...seen.values()], session.activity, connection.state)
    if (verdict.kind !== "pending") break
    await settled(250)
  }

  step("blocks observed", String(seen.size))
  for (const [key, block] of seen) {
    const text = block.kind === "userMessage" || block.kind === "text" || block.kind === "thinking"
      ? JSON.stringify(String(block.content).slice(0, 96))
      : block.kind === "system"
        ? JSON.stringify(String(block.message).slice(0, 140))
        : block.kind === "tool"
          ? `${block.presentation.name} ${block.presentation.detail} [${block.status}]`
          : ""
    say(`      ${key.padEnd(28)} ${text}`)
  }

  step("connection state", connection.state)
  step("session activity", session.activity ?? "(unknown)")
  step("total blocks", String(transcript.view.totalBlocks))
  step("transport verdict", verdict.kind === "passed" ? verdict.terminal : verdict.reason)

  const passed = verdict.kind === "passed"
  say(`\n${passed ? "LIVE TRANSPORT OK" : "LIVE TRANSPORT INCOMPLETE"}: supervisor, socket, intake, transcript, session\n`)
  session.dispose()
  process.exitCode = passed ? 0 : 1
} catch (cause) {
  console.error("live stack failed:", cause)
  process.exitCode = 1
} finally {
  await connection?.close().catch(() => {})
  await nativeConnection?.close().catch(() => {})
  if (accountProcess !== undefined) await stopOwnedRuntime(accountProcess)
  rmSync(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  rmSync(nativeProjectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  rmSync(bridgeProjectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  rmSync(accountHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  // The socket and the child's stream readers are live handles, so the loop
  // would stay open with the work already finished. Exit deliberately.
  process.exit(process.exitCode ?? 0)
}
