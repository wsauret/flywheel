import { describe, expect, test } from "bun:test"

import { createAccountServiceInstallation } from "../../../../src/orchestration/app-service/account-service-installation.js"
import { fixture, missing, ok, unanswered, type Response } from "./_account-service-fixtures.js"

/** logind's answer about the account: its name and whether its user manager
 *  outlives the last logout. */
const SHOW_USER = ["loginctl", "show-user", "1000", "-p", "Name", "-p", "Linger"]
const answering = (response: Response) => new Map([[SHOW_USER.join("\0"), response]])
const asked = (commands: readonly string[][]) => commands.filter((command) => command[0] === "loginctl")
const LINGERING_OFF = "Name=wes\nLinger=no\n"
const LINGERING_ON = "Name=wes\nLinger=yes\n"
/** The account's own request to logind, which systemd's polkit policy grants
 *  without a password on a default system. */
const ENABLE = ["loginctl", "enable-linger", "--no-ask-password", "1000"]

describe("the account's logind lingering", () => {
  test("names the account as logind states it while lingering is off, so the service stops at its last logout", async () => {
    const setup = fixture("linux", answering(ok(LINGERING_OFF)))

    expect(await setup.installation.lingerOffFor()).toBe("wes")
    expect(asked(setup.commands)).toEqual([SHOW_USER])
  })

  // A command that fails or does not answer prints the reading that names
  // the account, so only the command's outcome can decide the answer.
  test.each([
    ["lingering is on", ok("Name=wes\nLinger=yes\n")],
    ["loginctl fails", { ...missing, stdout: LINGERING_OFF }],
    ["loginctl does not answer", { ...unanswered, stdout: LINGERING_OFF }],
    ["loginctl reaches its timeout", { ...ok(LINGERING_OFF), timedOut: true }],
    ["logind names no user", ok("Linger=no\n")],
  ] as const)("answers nothing when %s", async (_case, response) => {
    expect(await fixture("linux", answering(response)).installation.lingerOffFor()).toBeUndefined()
  })

  test("ends loginctl within two seconds, so a slow logind never holds the serve install that prints the reading", async () => {
    const setup = fixture("linux")
    const bounds: Array<number | undefined> = []
    const installation = createAccountServiceInstallation(() => ({ ...setup.platform, runCommand: async (command, options) => {
      if (command[0] === "loginctl") bounds.push(options?.timeoutMs)
      return { exitCode: null, stdout: "", stderr: "", timedOut: true }
    } }))

    expect(await installation.lingerOffFor()).toBeUndefined()
    expect(bounds).toHaveLength(1)
    expect(bounds[0]).toBeLessThanOrEqual(2_000)
  })

  test("answers nothing when loginctl cannot be started", async () => {
    const setup = fixture("linux")
    const installation = createAccountServiceInstallation(() => ({ ...setup.platform, runCommand: async () => { throw new Error("no trusted loginctl") } }))

    expect(await installation.lingerOffFor()).toBeUndefined()
  })

  test("asks nothing for an account home that is not the login home", async () => {
    const setup = fixture("linux", answering(ok(LINGERING_OFF)), new Map(), "/scratch/other")

    expect(await setup.installation.lingerOffFor()).toBeUndefined()
    expect(asked(setup.commands)).toEqual([])
  })

  test.each(["darwin", "win32"] as const)("asks nothing on %s, where the service manager has no lingering", async (platform) => {
    const setup = fixture(platform)

    expect(await setup.installation.lingerOffFor()).toBeUndefined()
    expect(setup.commands).toEqual([])
  })
})

describe("registering the account service on Linux", () => {
  test("turns lingering on while it is off, so the service keeps running after the last logout and no notice follows", async () => {
    const setup = fixture("linux", new Map([[SHOW_USER.join("\0"), [ok(LINGERING_OFF), ok(LINGERING_ON)]]]))

    await setup.installation.install()

    expect(await setup.installation.lingerOffFor()).toBeUndefined()
    expect(asked(setup.commands)).toEqual([SHOW_USER, ENABLE, SHOW_USER])
  })

  // A distribution polkit rule refuses, and a logind that never answers or a
  // loginctl that cannot start proves nothing: the registration still
  // succeeds, and the notice names the command the person can run.
  test.each([
    ["logind refuses", { exitCode: 1, stdout: "", stderr: "Could not enable linger: Access denied" }],
    ["logind does not answer", unanswered],
    ["loginctl reaches its timeout", { ...ok(), timedOut: true }],
  ] as const)("keeps the logout notice when %s", async (_case, refusal) => {
    const setup = fixture("linux", new Map([[SHOW_USER.join("\0"), ok(LINGERING_OFF)], [ENABLE.join("\0"), refusal]]))

    await setup.installation.install()

    expect(await setup.installation.lingerOffFor()).toBe("wes")
    expect(asked(setup.commands)).toEqual([SHOW_USER, ENABLE, SHOW_USER])
  })

  test("keeps the logout notice when the enable cannot be started, and bounds the enable like the reading", async () => {
    const setup = fixture("linux")
    const bounds: Array<number | undefined> = []
    const installation = createAccountServiceInstallation(() => ({ ...setup.platform, runCommand: async (command, options) => {
      if (command[1] === "enable-linger") {
        bounds.push(options?.timeoutMs)
        throw new Error("no trusted loginctl")
      }
      return command[0] === "loginctl" ? ok(LINGERING_OFF) : ok()
    } }))

    await installation.install()

    expect(await installation.lingerOffFor()).toBe("wes")
    expect(bounds).toHaveLength(1)
    expect(bounds[0]).toBeLessThanOrEqual(2_000)
  })

  test.each([
    ["lingering is already on", ok(LINGERING_ON)],
    ["logind does not answer", unanswered],
  ] as const)("asks logind to change nothing when %s", async (_case, reading) => {
    const setup = fixture("linux", answering(reading))

    await setup.installation.install()

    expect(await setup.installation.lingerOffFor()).toBeUndefined()
    expect(asked(setup.commands)).toEqual([SHOW_USER, SHOW_USER])
  })

  test("asks logind nothing for an account home that is not the login home", async () => {
    const setup = fixture("linux", answering(ok(LINGERING_OFF)), new Map(), "/scratch/other")

    await setup.installation.install()

    expect(asked(setup.commands)).toEqual([])
  })
})
