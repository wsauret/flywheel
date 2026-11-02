import { describe, expect, test } from "bun:test"

import { createMessagePortProcessEndpoint } from "../../../src/infra/internal-process-channel.js"
import { createInternalProcessSubchannel } from "../../../src/infra/internal-process-subchannel.js"

function endpointPair() {
  const channel = new MessageChannel()
  return [
    createMessagePortProcessEndpoint({ port: channel.port1, decode: (value) => value }),
    createMessagePortProcessEndpoint({ port: channel.port2, decode: (value) => value }),
  ] as const
}

describe("internal process subchannels", () => {
  test("isolates tagged traffic and closing one borrower leaves its sibling live", async () => {
    const [owner, peer] = endpointPair()
    const ownerGuardian = createInternalProcessSubchannel(owner, "guardian")
    const ownerPersistent = createInternalProcessSubchannel(owner, "persistent")
    const peerGuardian = createInternalProcessSubchannel(peer, "guardian")
    const peerPersistent = createInternalProcessSubchannel(peer, "persistent")
    const guardianMessages: unknown[] = []
    const persistentMessages: unknown[] = []
    peerGuardian.onMessage((message) => { guardianMessages.push(message) })
    peerPersistent.onMessage((message) => { persistentMessages.push(message) })

    await ownerGuardian.send({ value: "guardian" })
    await ownerPersistent.send({ value: "persistent" })
    await Bun.sleep(0)
    expect(guardianMessages).toEqual([{ value: "guardian" }])
    expect(persistentMessages).toEqual([{ value: "persistent" }])

    ownerGuardian.close("guardian borrower closed")
    await expect(ownerGuardian.send("late")).rejects.toThrow("guardian borrower closed")
    await ownerPersistent.send({ value: "still live" })
    await Bun.sleep(0)
    expect(persistentMessages).toEqual([{ value: "persistent" }, { value: "still live" }])

    owner.close("control owner closed")
    await expect(ownerPersistent.closed).resolves.toBeUndefined()
    await expect(peerPersistent.closed).resolves.toBeUndefined()
    await expect(peerPersistent.send("late")).rejects.toThrow("peer closed")
  })

  test("does not deliver another closed channel tag", async () => {
    const [owner, peer] = endpointPair()
    const guardian = createInternalProcessSubchannel(peer, "guardian")
    const persistent = createInternalProcessSubchannel(peer, "persistent")
    const guardianMessages: unknown[] = []
    const persistentMessages: unknown[] = []
    guardian.onMessage((message) => { guardianMessages.push(message) })
    persistent.onMessage((message) => { persistentMessages.push(message) })

    await owner.send({ channel: "persistent", payload: { operation: "list" } })
    await owner.send({ channel: "guardian", payload: { kind: "lease" } })
    await owner.send({ channel: "other", payload: { kind: "intrusion" } })
    await Bun.sleep(0)

    expect(guardianMessages).toEqual([{ kind: "lease" }])
    expect(persistentMessages).toEqual([{ operation: "list" }])
    owner.close()
  })
})
