import { createMessagePortProcessEndpoint, type InternalProcessEndpoint, type listenInternalProcessChannel } from "../../../../src/infra/internal-process-channel.js"
import { createLauncherScope, type GuardianControl, type GuardianLoss, type OwnershipClosure } from "../../../../src/infra/process-supervisor.js"
import type { OwnedProcessExit } from "../../../../src/infra/owned-subprocess.js"
import type { TerminationCause } from "../../../../src/infra/process-container.js"
import { createProjectExecutorClient } from "../../../../src/orchestration/app-service/project-executor-client.js"
import type { ProcessorAdmission, ProcessorHolds } from "../../../../src/orchestration/app-service/processor-governor.js"
import { decodeProjectExecutorCommand, decodeProjectExecutorInitialization, encodeProjectExecutorCredential } from "../../../../src/orchestration/app-service/project-executor-protocol.js"
import { createProjectStateClient } from "../../../../src/orchestration/app-service/project-state-client.js"
import { createPersistentProcessManager } from "../../../../src/infra/persistent-process-manager.js"
import type { RuntimeChatDefault } from "../../../../src/protocol/app-service-types.js"
import { createLoginShellPath, type LoginShellPath } from "../../../../src/infra/login-shell-path.js"
import type { ProcessDiagnosticRecord } from "../../../../src/infra/process-diagnostic-reader.js"

const cleanup: (() => void)[] = []

/** Closes the message ports every fixture of the finished test opened. */
export function closeExecutorFixtures(): void {
  for (const close of cleanup.splice(0)) close()
}

/** A clock the test moves by hand. The client reads every deadline, reattach
 *  wait, and wedge watch from it, so none fires unless a test advances past
 *  it, and no case depends on how fast the machine runs. */
function manualClock() {
  let now = 0
  const timers = new Set<{ readonly at: number; readonly fire: () => void }>()
  return {
    now: () => now,
    setTimer(fire: () => void, delayMs: number) {
      const timer = { at: now + delayMs, fire }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    /** Moves the clock by `ms`. Each timer that falls due fires in order, and
     *  what it starts runs before the next one fires. */
    async advance(ms: number) {
      await settle()
      const until = now + ms
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.delete(next)
        now = next.at
        next.fire()
        await settle()
      }
      now = until
      await settle()
    },
  }
}

/** Lets every queued callback run, including the check the wedge watch defers
 *  behind pending I/O. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** One project executor client over in-memory channels, a scripted executor
 *  on their far side, and a launcher whose container exits on command. */
export function fixture(options: {
  earlySupervisorDiagnostic?: ProcessDiagnosticRecord
  stopDeadlineMs?: number; terminateWaits?: boolean; supervisorCannotRun?: boolean; readyAnswer?: Promise<void>; stopAnswer?: Promise<void>; stopSuccessorRows?: { readonly continuations: number; readonly handovers: number }; heartbeatIntervalMs?: number; blockersFailure?: string; blockersUnanswered?: boolean; handoffFailure?: string; guardianCloses?: OwnershipClosure[]; reattachDeadlineMs?: number; diagnostics?: boolean; rejectState?: boolean; wedged?: boolean; wrongCredential?: boolean; startupFailure?: boolean; executorPid?: number; projectRoot?: string; admission?: Promise<void>; guardianAdmission?: Promise<void>; guardianEntered?: () => void; launched?: () => void; listenerReady?: Promise<void>; chatDefaultStarted?: () => void; chatDefault?: RuntimeChatDefault; loginShellPath?: LoginShellPath; processorAdmission?: ProcessorAdmission } = {}) {
  const clock = manualClock()
  type Connection = { readonly peer: InternalProcessEndpoint<unknown, unknown>; readonly local: InternalProcessEndpoint<unknown, unknown> }
  const servers = new Map<string, () => Connection>()
  const peers: InternalProcessEndpoint<unknown, unknown>[] = []
  const connectionByKind = new Map<string, Connection>()
  let initialization: ReturnType<typeof decodeProjectExecutorInitialization>
  const observations: string[] = []
  const startDefaults: RuntimeChatDefault[] = []
  const loginShellPaths: string[] = []
  const processorHolds: ProcessorHolds[] = []
  const blockersRequests: number[] = []
  let launchCwd: string | undefined
  let launchPriority: string | undefined
  let launchChildrenBreakAway: boolean | undefined
  let onGuardianLost: ((loss: GuardianLoss) => void) | undefined
  const exited = Promise.withResolvers<OwnedProcessExit>()
  // The executor's diagnostic output, as the container supervisor pipes it.
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  const stderr = options.diagnostics ? new ReadableStream<Uint8Array>({ start(controller) { output = controller } }) : undefined
  const endOutput = (): void => { try { output?.close() } catch { /* already closed */ } }
  const listen: typeof listenInternalProcessChannel = (input) => {
    servers.set(input.path, () => {
      const pair = new MessageChannel()
      cleanup.push(() => { pair.port1.close(); pair.port2.close() })
      const local = createMessagePortProcessEndpoint({ port: pair.port1, decode: input.decode })
      input.onConnection(local)
      const peer = createMessagePortProcessEndpoint({ port: pair.port2, decode: (value) => value })
      peers.push(peer)
      return { peer, local }
    })
    return { ready: options.listenerReady ?? Promise.resolve(), async dispose() { observations.push(`dispose:${input.path}`) } }
  }
  const scope = createLauncherScope({ adoptOwned: () => Promise.reject(new Error("an executor launch adopts nothing")), spawnOwned: async (_command, launch) => {
    launchCwd = launch?.cwd
    launchPriority = launch?.priority
    launchChildrenBreakAway = launch?.childrenBreakAway
    onGuardianLost = launch?.onGuardianLost
    if (options.earlySupervisorDiagnostic !== undefined) launch?.diagnostics?.observe?.(options.earlySupervisorDiagnostic, 42)
    observations.push("launch")
    options.launched?.()
    const init = decodeProjectExecutorInitialization(JSON.parse(launch!.env!.FLYWHEEL_PROJECT_EXECUTOR!))
    if (!init) throw new Error("expected valid project executor initialization")
    initialization = init
    for (const kind of ["control", "state", "output", "lifecycle"] as const) {
      const connection = servers.get(init.endpoints[kind])!()
      connectionByKind.set(kind, connection)
      const { peer } = connection
      const credential = encodeProjectExecutorCredential({ projectId: init.projectId, generation: init.generation, endpoint: kind, credential: init.credentials[kind] })
      void peer.send(options.wrongCredential ? { ...credential, credential: "invalid-credential-invalid-credential" } : credential)
      if (kind === "lifecycle") {
        peer.onMessage(async (value) => {
          const command = decodeProjectExecutorCommand(value)
          if (!command) throw new Error("expected valid project executor command")
          observations.push(command.kind)
          if (command.kind === "start") {
            startDefaults.push(command.chatDefault)
            await options.readyAnswer
            await peer.send(options.startupFailure ? { kind: "failed", reason: "composition failed" } : { kind: "ready" })
          }
          if (command.kind === "login_shell_path") loginShellPaths.push(command.path)
          if (command.kind === "processor_holds") processorHolds.push(command.held)
          if (command.kind === "start_chat_default") options.chatDefaultStarted?.()
          if (command.kind === "stop" && !options.wedged) {
            await options.stopAnswer
            await peer.send({ kind: "stopped", ...(options.stopSuccessorRows === undefined ? {} : { successorRows: options.stopSuccessorRows }) })
          }
          if (command.kind === "blockers") {
            blockersRequests.push(command.id)
            if (options.blockersUnanswered) return
            await peer.send(options.blockersFailure === undefined
              ? { kind: "blockers", id: command.id, blockers: [] }
              : { kind: "command_failed", command: "blockers", id: command.id, reason: options.blockersFailure })
          }
          if (command.kind === "interrupt_for_replacement" || command.kind === "continue_after_replacement") {
            await peer.send(options.handoffFailure !== undefined
              ? { kind: "command_failed", command: command.kind, id: command.id, reason: options.handoffFailure }
              : { kind: "handoff", id: command.id, sessionIds: [`${command.kind}-session`] })
          }
        })
        if (options.executorPid !== undefined) void peer.send({ kind: "process", pid: options.executorPid })
        void peer.send({ kind: "heartbeat" })
      }
    }
    return {
      pid: 42, token: "executor", stdin: undefined, stdout: undefined, stderr,
      exited: exited.promise,
      async terminate(end?: TerminationCause) {
        observations.push("terminate")
        if (end !== undefined) {
          // This side ends the container itself, so whether its supervisor
          // can run does not matter.
          observations.push(`end: ${end.reason}`)
          for (const peer of peers) peer.close()
          endOutput()
          exited.resolve({ code: null, signal: "SIGKILL", statusOf: "supervisor", ownership: "surrendered" })
          return await exited.promise
        }
        // A supervisor that the scheduler does not run never carries a stop
        // out, as under a load that starves its background priority.
        if (options.supervisorCannotRun) return await new Promise<never>(() => {})
        // A supervisor that carries the stop out ends the executor later, by
        // the signal it sends, which the test states through exit().
        if (options.terminateWaits) return await exited.promise
        for (const peer of peers) peer.close()
        endOutput()
        const exit: OwnedProcessExit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" }
        exited.resolve(exit)
        return exit
      },
    }
  } })
  const guardian: GuardianControl = {
    pid: async () => 10,
    async openGeneration() {
      observations.push("guardian")
      options.guardianEntered?.()
      await options.guardianAdmission
      return {
        pid: async () => 10,
        request: async (command) => ({ kind: "released", token: command.token }),
        async close() { observations.push("guardian-close"); return options.guardianCloses?.shift() ?? { settled: true } },
      }
    },
  }
  return {
    observations,
    startDefaults,
    loginShellPaths,
    /** Each complete held set the executor was sent, in order. */
    processorHolds,
    clock,
    /** The executor side of the lifecycle channel, to send what an executor would. */
    lifecyclePeer: () => connectionByKind.get("lifecycle")?.peer,
    /** The id of each blockers request the executor was sent, in order. */
    blockersRequests,
    /** What the launched executor was told in its initialization. */
    initialization: () => initialization,
    launch: () => ({ cwd: launchCwd, priority: launchPriority, ...(launchChildrenBreakAway === undefined ? {} : { childrenBreakAway: launchChildrenBreakAway }) }),
    /** The executor process dies unasked, as a signal or a crash ends it: it
     *  writes its last output, its sockets drop, and it exits without
     *  answering anything. */
    exit(status: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly statusOf?: OwnedProcessExit["statusOf"] }, lastOutput?: string) {
      if (lastOutput !== undefined) output?.enqueue(new TextEncoder().encode(lastOutput))
      endOutput()
      for (const peer of peers) peer.close("socket reset")
      exited.resolve({ statusOf: "payload", ...status, ownership: "surrendered" })
    },
    /** The container writes diagnostic output and keeps running, as its
     *  supervisor writes a decision before its signal ends the executor. */
    write(text: string) {
      output?.enqueue(new TextEncoder().encode(text))
    },
    /** The account's supervisor reports that the guardian the executor's
     *  container depends on exited, as it does before it ends that container. */
    guardianLost(loss: GuardianLoss) {
      onGuardianLost?.(loss)
    },
    /** The executor side of one channel drops its socket. Resolves once the
     *  client has seen the socket close. */
    async dropPeer(kind: "control" | "state" | "output" | "lifecycle") {
      const connection = connectionByKind.get(kind)
      connection?.peer.close("socket reset")
      await connection?.local.closed
    },
    /** The executor side reconnects one channel with the credential it already holds. */
    reconnect(kind: "control" | "state" | "output" | "lifecycle") {
      const init = initialization
      if (!init) throw new Error("expected an initialized executor")
      const connection = servers.get(init.endpoints[kind])!()
      connectionByKind.set(kind, connection)
      const { peer } = connection
      void peer.send(encodeProjectExecutorCredential({ projectId: init.projectId, generation: init.generation, endpoint: kind, credential: init.credentials[kind] }))
      if (kind === "lifecycle") {
        peer.onMessage(async (value) => {
          const command = decodeProjectExecutorCommand(value)
          if (command?.kind === "login_shell_path") loginShellPaths.push(command.path)
          if (command?.kind === "processor_holds") processorHolds.push(command.held)
          if (command?.kind === "blockers") await peer.send({ kind: "blockers", id: command.id, blockers: [] })
          if (command?.kind === "stop") await peer.send({ kind: "stopped" })
        })
      }
    },
    acquire: () => createProjectExecutorClient({
      admit: () => options.admission ?? Promise.resolve(),
      projectId: "project", projectLabel: "project", generation: 1,
      directories: { userDataRoot: "/account/.flywheel", accountHome: "/account", projectRoot: options.projectRoot ?? "/project", executionCwd: "/project/sub" },
      endpoints: { control: "control", state: "state", output: "output", lifecycle: "lifecycle" },
      launcher: { scope, guardian, startGuardian: async () => {} }, listen, clock,
      ...(options.stopDeadlineMs !== undefined ? { stopDeadlineMs: options.stopDeadlineMs } : {}),
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.reattachDeadlineMs !== undefined ? { reattachDeadlineMs: options.reattachDeadlineMs } : {}),
      workerUrl: "file:///worker.ts",
      persistentProcesses: createPersistentProcessManager(),
      allowPersistentProcesses: false,
      allowPersistentLaunch: async () => false,
      notify: async () => {},
      chatDefault: () => options.chatDefault ?? { kind: "pending" },
      loginShellPath: options.loginShellPath ?? createLoginShellPath(),
      processorAdmission: options.processorAdmission ?? { join: () => ({ claim() {}, resend() {}, leave() {} }) },
      clientsHold: () => false,
      watchedOutput: () => [],
      state: { ...createProjectStateClient({
        send() {},
        onResponse() {},
        onClose() {},
        onStored() { return () => {} },
        onSessionChange() { return () => {} },
        async close() { observations.push("worker-close") },
      }),
      onStored() {
        if (options.rejectState) throw new Error("state unavailable")
        observations.push("state")
        return () => { observations.push("state-close") }
      } },
    }),
  }
}
