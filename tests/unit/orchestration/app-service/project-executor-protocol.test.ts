import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"

import {
  createProjectExecutorAuthenticator,
  createProjectExecutorChannelSet,
  decodeProjectExecutorCommand,
  decodeProjectExecutorCredential,
  decodeProjectExecutorEvent,
  decodeProjectExecutorInitialization,
  encodeProjectExecutorCredential,
  encodeProjectExecutorInitialization,
  projectExecutorChannelLimits,
} from "../../../../src/orchestration/app-service/project-executor-protocol.js"
import { createMessagePortProcessEndpoint, type InternalProcessEndpoint } from "../../../../src/infra/internal-process-channel.js"

test("executor channels carry a whole bounded state page as one message and lifecycle has no run stub", () => {
  expect(projectExecutorChannelLimits("state")).toEqual({ maxFrameBytes: 1024 * 1024, maxMessageBytes: 64 * 1024 * 1024, maxQueuedBytes: 8 * 1024 * 1024 })
  expect(projectExecutorChannelLimits("output")).toEqual({ maxFrameBytes: 1024 * 1024, maxMessageBytes: 64 * 1024 * 1024, maxQueuedBytes: 4 * 1024 * 1024 })
  expect(decodeProjectExecutorCommand({ kind: "run", id: 1, sessionId: "s" })).toBeUndefined()
  expect(decodeProjectExecutorEvent({ kind: "failed", reason: "startup failed" })).toEqual({ kind: "failed", reason: "startup failed" })
})

test("executor readiness carries no model-resolution state", () => {
  expect(decodeProjectExecutorEvent({ kind: "ready" })).toEqual({ kind: "ready" })
  expect(decodeProjectExecutorEvent({ kind: "ready", chatDefault: null })).toBeUndefined()
})

test("executor start carries the account-retained chat default", () => {
  expect(decodeProjectExecutorCommand({
    kind: "start",
    chatDefault: { kind: "model", model: "openai/gpt-5", effort: "medium" },
  })).toEqual({
    kind: "start",
    chatDefault: { kind: "model", model: "openai/gpt-5", effort: "medium" },
  })
  expect(decodeProjectExecutorCommand({ kind: "start", chatDefault: { kind: "pending" } })).toEqual({ kind: "start", chatDefault: { kind: "pending" } })
  expect(decodeProjectExecutorCommand({ kind: "start" })).toBeUndefined()
})

test("replacement travels the lifecycle channel: the state down, blockers up", () => {
  const blocker = { projectRoot: "/a", projectLabel: "a", sessionId: "a-1", sessionTitle: "Ask", reason: "question" as const }
  expect(decodeProjectExecutorCommand({ kind: "blockers", id: 3 })).toEqual({ kind: "blockers", id: 3 })
  expect(decodeProjectExecutorCommand({ kind: "replacement", state: { kind: "requested", blockers: [blocker] } })).toEqual({ kind: "replacement", state: { kind: "requested", blockers: [blocker] } })
  expect(decodeProjectExecutorCommand({ kind: "replacement", state: { kind: "draining", handoffId: "h1" } })).toEqual({ kind: "replacement", state: { kind: "draining", handoffId: "h1" } })
  // A drain always names the handoff whose cut every executor continues at its stop.
  expect(decodeProjectExecutorCommand({ kind: "replacement", state: { kind: "draining" } })).toBeUndefined()
  expect(decodeProjectExecutorCommand({ kind: "replacement", state: { kind: "requested" } })).toBeUndefined()
  expect(decodeProjectExecutorCommand({ kind: "status", id: 1 })).toBeUndefined()
  expect(decodeProjectExecutorEvent({ kind: "blockers", id: 3, blockers: [blocker] })).toEqual({ kind: "blockers", id: 3, blockers: [blocker] })
  expect(decodeProjectExecutorEvent({ kind: "blockers", blockers: [] })).toEqual({ kind: "blockers", blockers: [] })
  expect(decodeProjectExecutorEvent({ kind: "blockers", blockers: [{ ...blocker, reason: "sleeping" }] })).toBeUndefined()
  expect(decodeProjectExecutorEvent({ kind: "status", id: 1, hasLiveWork: false })).toBeUndefined()
  // A stop after a cut counts the handoff's continuation and handover rows;
  // an ordinary stop counts none.
  expect(decodeProjectExecutorEvent({ kind: "stopped", successorRows: { continuations: 2, handovers: 1 } })).toEqual({ kind: "stopped", successorRows: { continuations: 2, handovers: 1 } })
  expect(decodeProjectExecutorEvent({ kind: "stopped" })).toEqual({ kind: "stopped" })
  expect(decodeProjectExecutorEvent({ kind: "stopped", successorRows: { continuations: 0, handovers: -1 } })).toBeUndefined()
  expect(decodeProjectExecutorEvent({ kind: "stopped", successorRows: { continuations: 2 } })).toBeUndefined()
})

function endpointPair(): readonly [InternalProcessEndpoint<unknown, unknown>, InternalProcessEndpoint<unknown, unknown>] {
  const channel = new MessageChannel()
  return [
    createMessagePortProcessEndpoint({ port: channel.port1, decode: (value) => value }),
    createMessagePortProcessEndpoint({ port: channel.port2, decode: (value) => value }),
  ]
}

/** One executor generation's initialization: `lifecycle` and the credentials
 *  `auth` issues for the other three channels. */
function initialization(auth: ReturnType<typeof createProjectExecutorAuthenticator>, lifecycle: ReturnType<typeof auth.issue>["credential"]) {
  return {
    projectId: "project-a",
    projectLabel: "project-a",
    generation: 7,
    workerUrl: "worker.ts",
    allowPersistentProcesses: false,
    heartbeatIntervalMs: 1_000,
    directories: {
      userDataRoot: "/user",
      accountHome: "/account",
      projectRoot: "/project",
      executionCwd: "/project",
    },
    endpoints: {
      control: "/control",
      state: "/state",
      output: "/output",
      lifecycle: "/lifecycle",
    },
    credentials: {
      control: auth.issue("state").credential,
      state: auth.issue("output").credential,
      output: auth.issue("lifecycle").credential,
      lifecycle,
    },
  }
}

describe("project executor authentication", () => {
  test("keeps credentials redacted except at initialization and socket DTO boundaries", () => {
    const auth = createProjectExecutorAuthenticator({ projectId: "project-a", generation: 7 })
    const credential = auth.issue("control")
    expect(String(credential.credential)).toBe("<redacted>")

    const socketDto = encodeProjectExecutorCredential(credential)
    expect(typeof socketDto.credential).toBe("string")
    const decodedCredential = decodeProjectExecutorCredential(socketDto)
    expect(decodedCredential && Redacted.value(decodedCredential.credential)).toEqual(Redacted.value(credential.credential))

    const runtimeInit = initialization(auth, credential.credential)
    const initDto = encodeProjectExecutorInitialization(runtimeInit)
    expect(typeof initDto.credentials.control).toBe("string")
    const decodedInit = decodeProjectExecutorInitialization(initDto)
    expect(decodedInit && String(decodedInit.credentials.control)).toBe("<redacted>")
    expect(decodedInit && Redacted.value(decodedInit.credentials.control)).toEqual(Redacted.value(runtimeInit.credentials.control))
  })

  test("the initialization carries the heartbeat period the account counts in, and requires it", () => {
    const auth = createProjectExecutorAuthenticator({ projectId: "project-a", generation: 7 })
    const initDto = encodeProjectExecutorInitialization({ ...initialization(auth, auth.issue("control").credential), heartbeatIntervalMs: 100 })
    expect(decodeProjectExecutorInitialization(initDto)?.heartbeatIntervalMs).toBe(100)
    const { heartbeatIntervalMs: _period, ...withoutPeriod } = initDto
    expect(decodeProjectExecutorInitialization(withoutPeriod)).toBeUndefined()
    expect(decodeProjectExecutorInitialization({ ...initDto, heartbeatIntervalMs: 0 })).toBeUndefined()
  })

  test("accepts each one-time project-generation credential once and rejects replay or cross-project use", () => {
    const auth = createProjectExecutorAuthenticator({ projectId: "project-a", generation: 7 })
    const credential = auth.issue("control")

    expect(auth.accept({ ...credential, projectId: "project-b" })).toBe(false)
    expect(auth.accept(credential)).toBe(true)
    // The same secret admits a reattached channel within the generation.
    expect(auth.accept(credential)).toBe(true)
    auth.revoke()
    expect(auth.accept(credential)).toBe(false)
  })
})

describe("project executor channel isolation", () => {
  test("uses independent control, output, lifecycle and state endpoints", async () => {
    const [ownerControl, executorControl] = endpointPair()
    const [ownerOutput, executorOutput] = endpointPair()
    const [ownerLifecycle, executorLifecycle] = endpointPair()
    const [ownerState, executorState] = endpointPair()
    const owner = { control: ownerControl, output: ownerOutput, lifecycle: ownerLifecycle, state: ownerState }
    const executor = { control: executorControl, output: executorOutput, lifecycle: executorLifecycle, state: executorState }
    const channels = createProjectExecutorChannelSet(owner)
    const observed: string[] = []
    channels.control.onMessage(() => { observed.push("control") })
    channels.lifecycle.onMessage(() => { observed.push("lifecycle") })

    const outputWrites: Promise<void>[] = []
    for (let index = 0; index < 1_000; index++) outputWrites.push(executor.output.send({ index }))
    await executor.control.send({ kind: "stop" })
    await executor.lifecycle.send({ kind: "settled" })
    await Promise.all(outputWrites)
    await Bun.sleep(0)

    expect(observed).toEqual(["control", "lifecycle"])
    await channels.close("done")
    executor.control.close("done")
    executor.output.close("done")
    executor.lifecycle.close("done")
    executor.state.close("done")
  })

  test("settles every endpoint when one channel is lost", async () => {
    const [ownerControl, executorControl] = endpointPair()
    const [ownerOutput, executorOutput] = endpointPair()
    const [ownerLifecycle, executorLifecycle] = endpointPair()
    const [ownerState, executorState] = endpointPair()
    const owner = { control: ownerControl, output: ownerOutput, lifecycle: ownerLifecycle, state: ownerState }
    const executor = { control: executorControl, output: executorOutput, lifecycle: executorLifecycle, state: executorState }
    const channels = createProjectExecutorChannelSet(owner)
    executor.state.close("lost")
    await channels.closed
    await expect(channels.control.send({ kind: "late" })).rejects.toThrow()
    executor.control.close("done")
    executor.output.close("done")
    executor.lifecycle.close("done")
    executor.state.close("done")
  })
})
