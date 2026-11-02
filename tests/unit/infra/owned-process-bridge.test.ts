import { describe, expect, test } from "bun:test"

import { connectOwnedProcessBridge, serveOwnedProcessBridge } from "../../../src/infra/owned-process-bridge.js"
import { createMessagePortProcessEndpoint } from "../../../src/infra/internal-process-channel.js"
import type { GuardianCommand } from "../../../src/infra/process-guardian-protocol.js"
import type { GuardianGeneration, OwnershipClosure } from "../../../src/infra/process-supervisor.js"

const GUARDIAN_PID = 4_242

/** The generation a served bridge leases into, recorded so a frame the peer
 *  could not have produced can be seen to end it. */
function fakeGuardian() {
  const commands: GuardianCommand[] = []
  let closes = 0
  const generation: GuardianGeneration = {
    pid: () => Promise.resolve(GUARDIAN_PID),
    request: (command) => {
      commands.push(command)
      return Promise.resolve({ kind: "released", token: command.token })
    },
    close: () => {
      closes += 1
      return Promise.resolve({ settled: true })
    },
  }
  return {
    control: {
      openGeneration: () => Promise.resolve(generation),
      pid: () => Promise.resolve(GUARDIAN_PID),
    },
    commands,
    closes: () => closes,
  }
}

describe("owned-process bridge frames", () => {
  test("preserves behavior through the typed endpoint contract", async () => {
    const guardian = fakeGuardian()
    const channel = new MessageChannel()
    const ownerEndpoint = createMessagePortProcessEndpoint({ port: channel.port1, decode: (value) => value })
    const workerEndpoint = createMessagePortProcessEndpoint({ port: channel.port2, decode: (value) => value })
    const bridge = serveOwnedProcessBridge({ endpoint: ownerEndpoint, guardian: guardian.control, closeDeadlineMs: 5 })
    const peer = connectOwnedProcessBridge({ endpoint: workerEndpoint, requestDeadlineMs: 20 })

    await peer.launcher.close()
    bridge.peerExited()
    expect(await bridge.close()).toEqual({ settled: true })
  })

  test("forwards a lease command the peer states exactly", async () => {
    const guardian = fakeGuardian()
    const channel = new MessageChannel()
    serveOwnedProcessBridge({ port: channel.port1, guardian: guardian.control, closeDeadlineMs: 5 })
    channel.port2.start()

    channel.port2.postMessage({ v: 1, kind: "lease", id: 1, command: { kind: "release", token: "owned:1" } })
    await Bun.sleep(10)

    expect(guardian.commands).toEqual([{ kind: "release", token: "owned:1" }])
    expect(guardian.closes()).toBe(0)
    channel.port2.close()
  })

  test("ends the generation when the peer sends a frame it could not have produced", async () => {
    const guardian = fakeGuardian()
    const channel = new MessageChannel()
    serveOwnedProcessBridge({ port: channel.port1, guardian: guardian.control, closeDeadlineMs: 5 })
    channel.port2.start()

    // Every key this frame defines, and one more: a peer that adds a key is not
    // the peer this bridge speaks to, and its containers must not be left
    // running on the strength of the keys it happened to get right.
    channel.port2.postMessage({ v: 1, kind: "lease", id: 1, command: { kind: "release", token: "owned:1" }, extra: 1 })
    await Bun.sleep(20)

    expect(guardian.commands).toEqual([])
    expect(guardian.closes()).toBe(1)
    channel.port2.close()
  })

  test("ends its lifetime and what it launched when the answering peer sends a frame it could not have produced", async () => {
    const channel = new MessageChannel()
    const peer = connectOwnedProcessBridge({ port: channel.port2, requestDeadlineMs: 20 })
    channel.port1.start()

    channel.port1.postMessage({ v: 1, kind: "closed", extra: 1 })
    await Bun.sleep(20)

    expect(peer.lifetime.aborted).toBe(true)
    await expect(peer.launcher.spawnOwned(["true"])).rejects.toThrow("launcher scope is closed")
    channel.port1.close()
  })
})

describe("owned-process bridge peer exit", () => {
  for (const timing of ["before", "during"] as const) {
    test(`peer exit ${timing} close releases the peer wait but still awaits the guardian`, async () => {
      const guardian = fakeGuardian()
      const completion = Promise.withResolvers<OwnershipClosure>()
      let guardianCloses = 0
      const generation = await guardian.control.openGeneration()
      generation.close = () => { guardianCloses++; return completion.promise }
      const channel = new MessageChannel()
      const bridge = serveOwnedProcessBridge({
        port: channel.port1,
        guardian: { ...guardian.control, openGeneration: async () => generation },
        closeDeadlineMs: 20,
      })
      try {
        if (timing === "before") {
          channel.port2.close()
          bridge.peerExited()
        }
        const closed = bridge.close()
        if (timing === "during") {
          channel.port2.close()
          bridge.peerExited()
        }
        for (let hop = 0; hop < 32; hop++) await Promise.resolve()
        expect(guardianCloses).toBe(1)
        expect(await Promise.race([closed, Promise.resolve("pending")])).toBe("pending")
        expect(bridge.close()).toBe(closed)

        const failure = { settled: false, reason: "guardian has not proved the generation empty" } as const
        completion.resolve(failure)
        expect(await closed).toEqual(failure)
        expect(guardianCloses).toBe(1)
      } finally {
        completion.resolve({ settled: true })
        channel.port1.close()
        channel.port2.close()
      }
    })
  }
})
