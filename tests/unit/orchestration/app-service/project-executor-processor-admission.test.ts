import { afterEach, expect, test } from "bun:test"
import { createProcessorGovernor } from "../../../../src/orchestration/app-service/processor-governor.js"
import { closeExecutorFixtures, fixture } from "./_project-executor-fixture.js"

afterEach(closeExecutorFixtures)

test("claims reach the account's processor admission, and the executor hears its held set, again after a reattach, until its generation ends", async () => {
  const released: string[] = []
  const held = new Set<string>()
  let tick = (): void => {}
  const governor = createProcessorGovernor({
    budget: 1,
    clock: { every: (run) => { tick = run; return () => {} } },
    // Each container has four threads ready to run.
    processor: {
      demand: (refs) => new Map(refs.map((ref) => [ref.token, 4])),
      hold: (ref) => { held.add(ref.token); return true },
      release: (ref) => { if (held.delete(ref.token)) released.push(ref.token) },
    },
  })
  const host = fixture({ processorAdmission: governor, reattachDeadlineMs: 500 })
  const client = host.acquire()
  await client.ready
  const peer = host.lifecyclePeer()
  if (!peer) throw new Error("expected a lifecycle peer")
  await peer.send({ kind: "processor_claims", claims: [{ token: "a", pid: 11, order: 1, exempt: false }, { token: "b", pid: 12, order: 2, exempt: false }] })
  await Bun.sleep(5)
  // A container counts from its second reading.
  tick()
  tick()
  await Bun.sleep(5)
  expect(host.processorHolds).toEqual([[{ token: "b", ahead: 0 }]])

  await host.dropPeer("lifecycle")
  host.reconnect("lifecycle")
  // A reply on the lifecycle channel proves the reattach has happened.
  expect(await client.blockers()).toEqual([])
  expect(host.processorHolds).toEqual([[{ token: "b", ahead: 0 }], [{ token: "b", ahead: 0 }]])

  await client.stop()
  expect(released).toEqual(["b"])
})
