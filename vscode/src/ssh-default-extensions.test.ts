import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  addDefaultExtension,
  removeDefaultExtension,
  runSshAutoInstallOffer,
  shouldOfferSshAutoInstall,
  sshDefaultsWriteFailure,
  updateSshDefaultExtensions,
  type SshAutoInstallOfferContext,
} from "./ssh-default-extensions.js"

const FLYWHEEL = "flywheel-core-team.flywheel"

function offerContext(overrides: Partial<SshAutoInstallOfferContext> = {}): SshAutoInstallOfferContext {
  return {
    isRemoteWindow: false,
    remoteSshInstalled: true,
    alreadyOffered: false,
    defaultExtensions: [],
    extensionId: FLYWHEEL,
    ...overrides,
  }
}

describe("SSH default extensions", () => {
  test("adds Flywheel after every existing default extension", () => {
    assert.deepEqual(addDefaultExtension(["vendor.one", "vendor.two"], FLYWHEEL), [
      "vendor.one",
      "vendor.two",
      FLYWHEEL,
    ])
  })

  test("does not duplicate an existing extension with different casing", () => {
    assert.deepEqual(addDefaultExtension(["Flywheel-Core-Team.Flywheel"], FLYWHEEL), [
      "Flywheel-Core-Team.Flywheel",
    ])
  })

  test("removes only Flywheel and preserves every other extension", () => {
    assert.deepEqual(
      removeDefaultExtension(["vendor.one", "Flywheel-Core-Team.Flywheel", "vendor.two"], FLYWHEEL),
      ["vendor.one", "vendor.two"],
    )
  })

  test("offers automatic installation in an eligible local window", () => {
    assert.equal(shouldOfferSshAutoInstall(offerContext()), true)
  })

  test("does not offer in a remote window", () => {
    assert.equal(shouldOfferSshAutoInstall(offerContext({ isRemoteWindow: true })), false)
  })

  test("does not offer without Remote SSH", () => {
    assert.equal(shouldOfferSshAutoInstall(offerContext({ remoteSshInstalled: false })), false)
  })

  test("does not repeat an offer the user already answered", () => {
    assert.equal(shouldOfferSshAutoInstall(offerContext({ alreadyOffered: true })), false)
  })

  test("does not offer when Flywheel is already a default extension", () => {
    assert.equal(
      shouldOfferSshAutoInstall(offerContext({ defaultExtensions: ["Flywheel-Core-Team.Flywheel"] })),
      false,
    )
  })
})

describe("SSH default extension updates", () => {
  test("requires Remote SSH when enabling automatic installation", async () => {
    let wrote = false
    const result = await updateSshDefaultExtensions({
      enabled: true,
      remoteSshInstalled: false,
      defaultExtensions: [],
      extensionId: FLYWHEEL,
      write: () => {
        wrote = true
        return Promise.resolve()
      },
    })

    assert.deepEqual(result, { ok: false, reason: "remote_ssh_missing" })
    assert.equal(wrote, false)
  })

  test("writes nothing when disabling without Remote SSH, because VS Code refuses the setting", async () => {
    let wrote = false
    const result = await updateSshDefaultExtensions({
      enabled: false,
      remoteSshInstalled: false,
      defaultExtensions: ["vendor.one", FLYWHEEL],
      extensionId: FLYWHEEL,
      write: () => {
        wrote = true
        return Promise.resolve()
      },
    })

    assert.deepEqual(result, { ok: false, reason: "remote_ssh_missing" })
    assert.equal(wrote, false)
  })

  test("reports a rejected settings write", async () => {
    const failure = new Error("read only")
    const result = await updateSshDefaultExtensions({
      enabled: true,
      remoteSshInstalled: true,
      defaultExtensions: ["vendor.one"],
      extensionId: FLYWHEEL,
      write: () => Promise.reject(failure),
    })

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.reason, "write_failed")
      if (result.reason === "write_failed") assert.equal(result.cause, failure)
    }
  })

  test("records an accepted offer before its confirmation closes", async () => {
    const steps: string[] = []
    await runSshAutoInstallOffer({
      ask: async () => "accept",
      enable: async () => { steps.push("enable"); return true },
      recordOffered: async () => { steps.push("record") },
      // A confirmation nobody closes: the offer must not wait for it.
      confirm: () => { steps.push("confirm"); void new Promise(() => {}) },
    })
    assert.deepEqual(steps, ["enable", "record", "confirm"])
  })

  test("asks again after an accepted offer whose write failed, and never after a decline", async () => {
    const recorded: string[] = []
    await runSshAutoInstallOffer({ ask: async () => "accept", enable: async () => false, recordOffered: async () => { recorded.push("failed") }, confirm: () => {} })
    await runSshAutoInstallOffer({ ask: async () => "decline", enable: async () => true, recordOffered: async () => { recorded.push("declined") }, confirm: () => {} })
    assert.deepEqual(recorded, ["declined"])
  })

  test("names the cause of a refused settings write in plain words", () => {
    const vsCodeError = (message: string) => Object.assign(new Error(message), { name: "CodeExpectedError" })
    const locked = sshDefaultsWriteFailure(vsCodeError("Error while writing to User Settings. Unable to write file 'vscode-userdata:/u/settings.json' (NoPermissions (FileSystemError): Error: EPERM: operation not permitted, rename '/u/settings.json.vsctmp')"))
    assert.equal(locked, "VS Code could not write your user settings file. Make sure the file is not locked or read-only, then try again.")
    assert.equal(sshDefaultsWriteFailure(vsCodeError("Unable to write to User Settings because remote.SSH.defaultExtensions is not a registered configuration.")), "VS Code saves this setting only while the Remote - SSH extension is installed.")
    assert.equal(sshDefaultsWriteFailure(vsCodeError("Unable to write into user settings. Please open the user settings to correct errors/warnings in it and try again.")), "Your user settings file has errors. Correct them, then try again.")
    assert.equal(sshDefaultsWriteFailure(vsCodeError("Unable to write into user settings because the file has unsaved changes. Please save the user settings file first and then try again.")), "Your user settings file has unsaved changes. Save it, then try again.")
    assert.equal(sshDefaultsWriteFailure("something else"), "VS Code could not save your user settings.")
  })
})
