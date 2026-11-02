import { describe, expect, spyOn, test } from "bun:test"

import { createRegistrationFollower, rememberAnsweredLoginHome, serveResidency } from "../../../src/cli/serve.js"
import { Log } from "../../../src/infra/log.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"

/** Whether an account service stays up while nothing holds it, and how a
 *  client-started service in the login home follows its registration. */
describe("flywheel serve: residency", () => {
  /** Neither resident nor following a registration: it retires once nothing holds it. */
  const RETIRES = { resident: false, followsRegistration: false } as const
  /** Asks no registration question. */
  const unasked = async (): Promise<boolean> => { throw new Error("residency must not ask whether a registration exists") }

  test("the installed service is resident when its service manager started it, and asks nothing about the login home or a registration", async () => {
    let probes = 0
    const isLoginHome = async () => { probes += 1; return false }
    expect(await serveResidency({ lane: "installed", env: {}, startedByManager: () => true, isLoginHome, registered: unasked })).toEqual({ resident: true, followsRegistration: false })
    expect(probes).toBe(0)
  })

  test("a client-started installed service in a proven login home is resident only while no registration exists there", async () => {
    let probes = 0
    let registrationReads = 0
    const probe = (answer: boolean) => async () => { probes += 1; return answer }
    const registration = (answer: boolean | Error) => async () => {
      registrationReads += 1
      if (answer instanceof Error) throw answer
      return answer
    }
    const unmanaged = () => false
    const installed = (isLoginHome: () => Promise<boolean>, registered: () => Promise<boolean>) => serveResidency({ lane: "installed", env: {}, startedByManager: unmanaged, isLoginHome, registered })

    expect(await installed(probe(true), registration(false))).toEqual({ resident: true, followsRegistration: true })
    // A registration that exists, enabled or disabled, belongs to the
    // registered job, which is the resident owner of the login home.
    expect(await installed(probe(true), registration(true))).toEqual({ resident: false, followsRegistration: true })
    // A registration question that did not answer proves nothing; the build
    // tick asks again, and owns the one warning of the streak.
    const warn = spyOn(Log.create({ service: "serve" }), "warn")
    try {
      expect(await installed(probe(true), registration(new Error("schtasks did not answer")))).toEqual({ resident: false, followsRegistration: true })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(registrationReads).toBe(3)
    // Another home follows nothing and asks nothing about a registration.
    expect(await installed(probe(false), registration(false))).toEqual(RETIRES)
    expect([probes, registrationReads]).toEqual([4, 3])
    // The dev lane never is resident, and asks nothing.
    expect(await serveResidency({ lane: "dev", env: {}, startedByManager: () => true, isLoginHome: probe(true), registered: unasked })).toEqual(RETIRES)
    expect(probes).toBe(4)
  })

  test("a harness keeps the installed service resident in an isolated home", async () => {
    const env = { FLYWHEEL_INTERNAL_RESIDENT_SERVICE: "1" }
    expect(await serveResidency({ lane: "installed", env, startedByManager: () => false, isLoginHome: async () => false, registered: unasked })).toEqual({ resident: true, followsRegistration: false })
    expect(await serveResidency({ lane: "dev", env, startedByManager: () => true, isLoginHome: async () => true, registered: unasked })).toEqual(RETIRES)
  })

  test("a client-started service follows its registration on each build tick, with one record for each change and one warning for each unanswered streak", async () => {
    let answer: () => boolean = () => true
    let reads = 0
    let follows = true
    const lifetime = new ServeLifetime({ resident: true })
    const residencies: boolean[] = []
    const info = spyOn(Log.create({ service: "serve" }), "info")
    const warn = spyOn(Log.create({ service: "serve" }), "warn")
    const records = (spy: typeof info, text: string) => spy.mock.calls.filter(([message]) => String(message).includes(text)).length
    const tick = createRegistrationFollower({
      followsRegistration: () => follows,
      registered: async () => {
        reads += 1
        return answer()
      },
      setResident: (resident) => {
        residencies.push(resident)
        return lifetime.setResident(resident)
      },
    })
    try {
      // A registration that appears ends the residency, and only the change
      // is recorded, however often the tick reads it.
      await tick()
      await tick()
      expect(residencies).toEqual([false, false])
      expect(records(info, "a registration now exists")).toBe(1)
      // Reads that do not answer keep the residency and warn once.
      answer = () => { throw new Error("schtasks did not answer") }
      await tick()
      await tick()
      expect(residencies).toEqual([false, false])
      expect(records(warn, "could not be read")).toBe(1)
      // A registration that disappears makes the service resident again,
      // and the next unanswered read starts a new streak.
      answer = () => false
      await tick()
      expect(residencies).toEqual([false, false, true])
      expect(records(info, "no registration exists")).toBe(1)
      answer = () => { throw new Error("schtasks did not answer") }
      await tick()
      expect(records(warn, "could not be read")).toBe(2)
      expect(reads).toBe(6)

      // A service whose residency does not follow the registration, or is
      // not decided yet, reads nothing.
      follows = false
      await tick()
      expect(reads).toBe(6)
    } finally {
      info.mockRestore()
      warn.mockRestore()
      lifetime.stop()
    }
  })

  test("the service remembers the login home only once a question answers it, and callers share a question in flight", async () => {
    const answers: readonly (boolean | undefined | Error)[] = [undefined, new Error("dscacheutil did not answer"), true]
    let asked = 0
    const loginHome = rememberAnsweredLoginHome(async () => {
      const answer = answers[asked]
      asked += 1
      if (answer instanceof Error) throw answer
      return answer
    })

    // A question that did not answer proves nothing, so the next caller asks again.
    expect(await loginHome()).toBeUndefined()
    await expect(loginHome()).rejects.toThrow("dscacheutil did not answer")
    expect(await Promise.all([loginHome(), loginHome()])).toEqual([true, true])
    expect(asked).toBe(3)
    // An answer is kept.
    expect(await loginHome()).toBe(true)
    expect(asked).toBe(3)
  })

  test("a login home that could not be read or named never makes an unmanaged service resident", async () => {
    const unmanaged = () => false
    expect(await serveResidency({ lane: "installed", env: {}, startedByManager: unmanaged, isLoginHome: async () => { throw new Error("dscacheutil failed") }, registered: unasked })).toEqual(RETIRES)
    expect(await serveResidency({ lane: "installed", env: {}, startedByManager: unmanaged, isLoginHome: async () => undefined, registered: unasked })).toEqual(RETIRES)
    // A service its manager started stays resident whatever the probe says.
    expect(await serveResidency({ lane: "installed", env: {}, startedByManager: () => true, isLoginHome: async () => { throw new Error("dscacheutil failed") }, registered: unasked })).toEqual({ resident: true, followsRegistration: false })
  })
})
