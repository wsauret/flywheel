import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { BROWSER_LOGIN_COPY } from "../../../src/protocol/client/provider-account-copy.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import type { SubscriptionSpendConsentMutationResult, SubscriptionSpendConsentView } from "../../../src/protocol/subscription-spend-consent-protocol-types.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("providers-sheet-interaction-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "providers-sheet-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelProvidersSheetTestClient') }",
        loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Providers sheet fixture build produced no JavaScript")
const { mountProviderBrowserLogin, mountProfileDeletion }: typeof import("./providers-sheet-interaction-fixture.js") =
  await importBuiltModule(javascript)

const recoveryQuestion = { questionId: "episode-background", providerId: "claude_agent_sdk", instanceId: "account-background", profileId: "background", profileDisplayName: "Background", providerDisplayName: "Anthropic Subscription", accountDisplayName: "person@example.invalid" }

test("closing automatic browser login cancels only its captured question and operation", async () => {
  const mounted = mountProviderBrowserLogin(undefined, [], { question: recoveryQuestion })
  await mounted.ready()
  assert.deepEqual(mounted.mutations()[0], { type: "auth.login", providerId: "claude_agent_sdk", instanceId: "account-background", loginQuestionId: "episode-background" })
  mounted.dispose()
  assert.deepEqual(mounted.mutations().at(-1), { type: "auth.login.cancel", loginQuestionId: "episode-background", operationId: "browser-operation" })
})

test("closing before the URL cancels by question and ignores the late answer", async () => {
  const response = Promise.withResolvers<import("../../../src/protocol/auth-login-protocol-types.js").RuntimeAuthLoginResult>()
  const mounted = mountProviderBrowserLogin(undefined, [], { question: recoveryQuestion, response: response.promise })
  await mounted.ready()
  mounted.dispose()
  response.resolve({ kind: "browser", providerId: "claude_agent_sdk", operationId: "late", authorizeUri: "https://example.invalid/login" })
  await mounted.ready()
  assert.deepEqual(mounted.mutations().at(-1), { type: "auth.login.cancel", loginQuestionId: "episode-background" })
  assert.deepEqual(mounted.opened(), [])
  assert.deepEqual(mounted.reports(), [])
})

test("ignored automatic answers are silent and do not cancel on later cleanup", async () => {
  const mounted = mountProviderBrowserLogin(undefined, [], { question: recoveryQuestion, response: Promise.resolve({ kind: "ignored", providerId: "claude_agent_sdk" }) })
  await mounted.ready()
  mounted.dispose()
  assert.equal(mounted.mutations().length, 1)
  assert.deepEqual(mounted.reports(), [])
})

test("recovery sends its answer while a manual login is still starting and retains its account lead", async () => {
  const manual = Promise.withResolvers<import("../../../src/protocol/auth-login-protocol-types.js").RuntimeAuthLoginResult>()
  const mounted = mountProviderBrowserLogin(undefined, undefined, { question: recoveryQuestion, manualResponse: manual.promise })
  try {
    await mounted.ready()
    mounted.focus({ kind: "reconnect-account", question: recoveryQuestion })
    await mounted.ready()
    assert.equal(mounted.mutations().filter((request) => request.type === "auth.login").length, 2)
    assert.match(mounted.text(), /person@example.invalid in profile Background/)
    manual.resolve({ kind: "failed", providerId: "chatgpt", message: "replaced" })
    await mounted.ready()
    assert.match(mounted.text(), /person@example.invalid in profile Background/)
    assert.deepEqual(mounted.reports(), [])
  } finally { mounted.dispose() }
})

test("a recovery transport failure releases question presentation for a later publication", async () => {
  const response = Promise.withResolvers<import("../../../src/protocol/auth-login-protocol-types.js").RuntimeAuthLoginResult>()
  const mounted = mountProviderBrowserLogin(undefined, [], { question: recoveryQuestion, response: response.promise })
  try {
    response.reject(new Error("transport disconnected"))
    await mounted.ready()
    assert.deepEqual(mounted.retried(), [recoveryQuestion.questionId])
  } finally { mounted.dispose() }
})

test("a recovery answer that arrives after Cancel leaves the Authentication list", async () => {
  const response = Promise.withResolvers<import("../../../src/protocol/auth-login-protocol-types.js").RuntimeAuthLoginResult>()
  const mounted = mountProviderBrowserLogin(undefined, [], { question: recoveryQuestion, response: response.promise })
  try {
    await mounted.ready()
    mounted.clickButton("Cancel")
    await mounted.ready()
    response.resolve({ kind: "browser", operationId: "late-operation", providerId: "claude_agent_sdk", authorizeUri: "https://provider.example/authorize" })
    await mounted.ready()
    assert.doesNotMatch(mounted.text(), /Connect Anthropic Subscription/)
  } finally { mounted.dispose() }
})

test("profile actions report fulfilled refusals without announcing success", async () => {
  for (const [label, projectBinding] of [
    ["Work", undefined],
    ["New profile", undefined],
    ["Always use this profile", undefined],
    ["Stop pinning", "personal"],
  ] as const) {
    const mounted = mountProfileDeletion({ kind: "fresh-default", source: { id: "personal", displayName: "Personal" } }, {
      profile: { id: "personal", displayName: "Personal", source: "environment", projectBinding, availableProfiles: [{ id: "personal", displayName: "Personal" }, { id: "work", displayName: "Work" }] },
      dispatch: async () => ({ ok: false, error: "Profile action refused" }),
    })
    try {
      assert.match(mounted.text(), /Unset FLYWHEEL_AUTH_PROFILE/)
      mounted.click(label)
      await mounted.reported
      assert.equal(mounted.mutations().length, 1)
      assert.deepEqual(mounted.reports().map(({ severity }) => severity), ["warning"])
      assert.match(mounted.reports()[0]!.message, /Profile action refused/)
    } finally { mounted.dispose() }
  }
})

test("profile names save inline on Enter and blur, retain focus while saving, and restore after refusal", async () => {
  const pending = Promise.withResolvers<import("../../../src/protocol/auth-profile-selection-protocol-types.js").RuntimeAuthProfileMutationResult>()
  let response = pending.promise
  const mounted = mountProfileDeletion({ kind: "fresh-default", source: { id: "personal", displayName: "Personal" } }, { dispatch: () => response })
  try {
    const edit = mounted.elements().find(node => String(node.properties["aria-label"]).startsWith("Profile name:"))
    assert.ok(edit)
    const open = edit.properties.onClick
    if (typeof open === "function") open()
    await mounted.ready()
    const input = mounted.elements().find(node => node.properties["aria-label"] === "Profile name")
    assert.ok(input)
    const type = input.properties.onInput
    const key = input.properties.onKeyDown
    if (typeof type === "function") type({ currentTarget: { value: "Work" } })
    if (typeof key === "function") key({ key: "Enter", preventDefault() {}, stopPropagation() {} })
    assert.equal(mounted.mutations().length, 1)
    assert.equal(input.ownerDocument.activeElement, input)
    assert.equal(input.properties["aria-disabled"], true)
    assert.notEqual(input.properties.disabled, true)
    assert.match(mounted.text(), /Saving…/)
    assert.equal(input.properties.value, "Work")
    assert.ok(!mounted.buttonLabels().includes("Save"))
    pending.resolve({ ok: false, error: "Rename refused" })
    await mounted.reported
    await mounted.ready()
    assert.match(mounted.reports().at(-1)!.message, /Rename refused/)
    assert.ok(mounted.elements().includes(edit))
    assert.match(String(edit.properties["aria-label"]), /Personal/)
    response = Promise.resolve({ id: "personal" })
    const reopen = edit.properties.onClick
    if (typeof reopen === "function") reopen()
    await mounted.ready()
    const second = mounted.elements().find(node => node.properties["aria-label"] === "Profile name")
    const change = second?.properties.onInput
    const blur = second?.properties.onBlur
    if (typeof change === "function") change({ currentTarget: { value: "Personal work" } })
    if (typeof blur === "function") blur()
    await mounted.ready()
    assert.deepEqual(mounted.mutations().at(-1), { type: "auth.profile.rename", scope: { kind: "defaults" }, id: "personal", displayName: "Personal work" })
  } finally { mounted.dispose() }
})

test("profile actions preserve warnings instead of reporting unqualified success", async () => {
  for (const label of ["Work", "New profile", "Always use this profile"] as const) {
    const mounted = mountProfileDeletion({ kind: "fresh-default", source: { id: "personal", displayName: "Personal" } }, {
      profile: { id: "personal", displayName: "Personal", source: "project", availableProfiles: [{ id: "personal", displayName: "Personal" }, { id: "work", displayName: "Work" }] },
      dispatch: async () => ({ id: "work", warning: "This project still uses Personal." }),
    })
    try {
      mounted.click(label)
      await mounted.reported
      assert.deepEqual(mounted.reports(), [{ severity: "warning", message: "This project still uses Personal." }])
    } finally { mounted.dispose() }
  }
})

test("profile deletion requires a choice and retains the source and choice for retry", async () => {
  const mounted = mountProfileDeletion({ kind: "choose", source: { id: "work", displayName: "Work" }, candidates: [{ id: "personal", displayName: "Personal" }, { id: "other", displayName: "Other" }] })
  try {
    mounted.click("Delete a profile")
    mounted.click("Work")
    await mounted.ready()
    assert.equal(mounted.disabled("Delete"), true)
    assert.equal(mounted.focused("Cancel"), true)
    mounted.blur("Cancel")
    mounted.choose("personal")
    await mounted.ready()
    // Choosing a successor keeps the person on the choice.
    assert.equal(mounted.focused("Cancel"), false)
    mounted.fail(true)
    mounted.click("Delete")
    assert.match(mounted.text(), /Deleting\.\.\./)
    assert.doesNotMatch(mounted.text(), /Cancel/)
    mounted.retireSource()
    await mounted.ready()
    assert.equal(mounted.mutations().length, 1)
    assert.match(mounted.text(), /cleanup failed/)
    assert.match(mounted.text(), /Delete Work/)
    mounted.fail(false)
    mounted.click("Delete")
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), Array.from({ length: 2 }, () => ({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "personal" })))
    assert.doesNotMatch(mounted.text(), /Delete Work/)
  } finally { mounted.dispose() }
})

test("last and automatic profile deletion submit exact owner targets, while cancel does not mutate", async () => {
  for (const kind of ["fresh-default", "automatic"] as const) {
    const mounted = mountProfileDeletion(kind === "fresh-default" ? { kind, source: { id: "default", displayName: "Default" } } : { kind, source: { id: "default", displayName: "Default" }, successor: { id: "personal", displayName: "Personal" } })
    try {
      mounted.click("Delete a profile")
      mounted.click("Default")
      await mounted.ready()
      assert.match(mounted.text(), kind === "fresh-default" ? /fresh Default/ : /Sessions will move to Personal/)
      mounted.click("Cancel")
      assert.equal(mounted.mutations().length, 0)
      mounted.click("Delete a profile")
      mounted.click("Default")
      await mounted.ready()
      mounted.click("Delete")
      await mounted.ready()
      assert.deepEqual(mounted.mutations(), [{ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "default", successorId: kind === "fresh-default" ? null : "personal" }])
    } finally { mounted.dispose() }
  }
})

test("profile preview can be cancelled before settlement and retried after failure", async () => {
  const mounted = mountProfileDeletion({ kind: "fresh-default", source: { id: "default", displayName: "Default" } })
  try {
    mounted.click("Delete a profile")
    mounted.click("Default")
    assert.equal(mounted.disabled("Delete"), true)
    mounted.click("Cancel")
    await mounted.ready()
    assert.doesNotMatch(mounted.text(), /Delete Default/)
    mounted.failPreview(true)
    mounted.click("Delete a profile")
    mounted.click("Default")
    await mounted.ready()
    assert.match(mounted.text(), /preview unavailable/)
    mounted.failPreview(false)
    mounted.blur("Cancel")
    mounted.click("Retry")
    await mounted.ready()
    assert.equal(mounted.focused("Cancel"), true)
    assert.equal(mounted.disabled("Delete"), false)
    assert.equal(mounted.mutations().length, 0)
  } finally { mounted.dispose() }
})

test("rejected custom rows explain configuration errors without credential actions", async () => {
  const firstParty = {
    providerId: "openai_api", displayName: "OpenAI", kind: "singleton", source: "stored_key",
    expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 0, group: "model", accounts: [],
  } as const
  const mounted = mountProviderBrowserLogin(undefined, [
    firstParty,
    { ...firstParty, providerId: "rejected-custom:openai_api", displayName: "[custom_providers.openai_api] (rejected)", source: "misconfigured", detail: "id is reserved by a first-party provider" },
  ])
  try {
    await mounted.ready()
    const rejected = mounted.cards().find((card) => card.text.includes("[custom_providers.openai_api]"))
    assert.ok(rejected)
    assert.match(rejected.text, /id is reserved by a first-party provider/)
    assert.deepEqual(rejected.buttons, [])
    assert.deepEqual(mounted.buttonLabels().filter((label) => label === "Disconnect"), ["Disconnect"])
    mounted.clickButton("Disconnect")
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), [{ type: "auth.account.disconnect", providerId: "openai_api", profileId: "personal" }])
  } finally {
    mounted.dispose()
  }
})

test("Disconnect of a Claude login asks before it logs the account out of the Flywheel profile", async () => {
  const mounted = mountProviderBrowserLogin(undefined, [{
    providerId: "claude_agent_sdk", displayName: "Anthropic Subscription", kind: "subscription", source: "oauth",
    expired: false, modelCapable: true, loginMethod: "browser-auth", loginProgram: "Claude", statusRank: 0, group: "model",
    accounts: [{ instanceId: "uuid-person", accountCorrelationId: "person", identity: "person@example.com", displayLabel: "person@example.com", expired: false, source: "oauth" }],
  }])
  try {
    await mounted.ready()
    mounted.clickButton("Disconnect")
    await mounted.ready()
    assert.deepEqual(mounted.confirmations().map(({ title, detail }) => ({ title, detail })), [{
      title: "Disconnect person@example.com?",
      detail: "This logs person@example.com out of this Flywheel profile. Claude and other apps keep their own logins. Log in again to reconnect.",
    }])
    assert.deepEqual(mounted.mutations(), [{ type: "auth.account.disconnect", providerId: "claude_agent_sdk", instanceId: "uuid-person", profileId: "personal" }])
  } finally {
    mounted.dispose()
  }
})

test("a new auth snapshot keeps the provider cards the sheet already shows", async () => {
  const google = {
    providerId: "google_api", displayName: "Google API Key", kind: "singleton", source: "invalid",
    expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 0, group: "model", accounts: [],
  } as const
  const mounted = mountProviderBrowserLogin(undefined, [google, { ...google, providerId: "openai_api", displayName: "OpenAI API Key", source: "stored_key" }])
  try {
    await mounted.ready()
    const card = mounted.card("Google API Key")
    assert.ok(card)
    await mounted.republishAuth()
    assert.equal(mounted.card("Google API Key"), card)
  } finally {
    mounted.dispose()
  }
})

test("account names save inline on blur, Enter, close, and a profile switch, and an empty name clears the label", async () => {
  const provider = {
    providerId: "chatgpt", displayName: "ChatGPT", kind: "subscription", source: "oauth",
    expired: false, modelCapable: true, loginMethod: "browser-auth", statusRank: 0, group: "model",
    accounts: [{ instanceId: "account", accountCorrelationId: "account", identity: "person@example.com", displayLabel: "Personal", label: "Personal", expired: false, source: "oauth" }],
  } as const
  for (const finish of ["blur", "Enter", "close", "profile switch"] as const) {
    const pending = Promise.withResolvers<{ readonly ok: false; readonly error: string }>()
    const mounted = mountProviderBrowserLogin(undefined, [provider], undefined, undefined, undefined, () => pending.promise)
    let disposed = false
    try {
      const edit = mounted.elements().find(node => String(node.properties["aria-label"]).startsWith("Account name:"))
      assert.ok(edit)
      const open = edit.properties.onClick
      if (typeof open === "function") open()
      await mounted.ready()
      const input = mounted.elements().find(node => node.properties["aria-label"] === "Account name")
      assert.ok(input)
      const change = input.properties.onInput
      if (typeof change === "function") change({ currentTarget: { value: finish === "Enter" ? "" : "Work" } })
      assert.deepEqual(mounted.mutations(), [], "typing alone writes nothing")
      if (finish === "close") { mounted.dispose(); disposed = true }
      else if (finish === "profile switch") assert.doesNotThrow(() => mounted.switchToEmptyProfile())
      else {
        const handler = input.properties[finish === "blur" ? "onBlur" : "onKeyDown"]
        if (typeof handler === "function") handler({ key: "Enter", preventDefault() {}, stopPropagation() {} })
        assert.ok(mounted.elements().includes(input))
        assert.equal(input.ownerDocument.activeElement, input)
        assert.equal(input.properties["aria-disabled"], true)
        assert.match(mounted.text(), /Saving…/)
      }
      assert.deepEqual(mounted.mutations(), [{ type: "auth.account.rename", providerId: "chatgpt", instanceId: "account", profileId: "personal", ...(finish === "Enter" ? {} : { label: "Work" }) }])
      assert.ok(!mounted.buttonLabels().includes("Save"))
      pending.resolve({ ok: false, error: "Account rename refused" })
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
      assert.match(mounted.reports().at(-1)!.message, /Account rename refused/)
      if (!disposed && finish !== "profile switch") assert.match(String(edit.properties["aria-label"]), /Personal/)
    } finally { if (!disposed) mounted.dispose() }
  }
})

test("paid-use ticks write one saved decision, keep their checkbox through publication, and restore it on failure", async () => {
  const provider = {
    providerId: "chatgpt", displayName: "ChatGPT", kind: "subscription", source: "oauth",
    expired: false, modelCapable: true, loginMethod: "browser-auth", statusRank: 0, group: "model",
    accounts: [{ instanceId: "account", accountCorrelationId: "account", identity: "person@example.com", displayLabel: "Personal", expired: false, source: "oauth" }],
  } as const
  const consent: Extract<SubscriptionSpendConsentView, { kind: "available" }> = {
    kind: "available", profileId: "personal", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1,
    accounts: [{ accountCorrelationId: "account", providerId: "chatgpt", providerDisplayName: "ChatGPT", providerStatus: "ok", modes: [
      { mode: "prepaid", envelopeId: "prepaid", decision: "unreviewed", evidence: { kind: "prepaid", availability: "unknown" } },
      { mode: "automatic", envelopeId: "automatic", decision: "accepted", evidence: { kind: "automatic-billing", enablement: "unknown" } },
    ] }],
  }
  const accepted = { ...consent, authorityRevision: 2, accounts: consent.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => ({ ...mode, decision: "accepted" as const })) })) }
  const pending = Promise.withResolvers<SubscriptionSpendConsentMutationResult>()
  let response = pending.promise
  const mounted = mountProviderBrowserLogin(undefined, [provider], undefined, undefined, { consent, response: () => response })
  try {
    await mounted.ready()
    const checkbox = mounted.checkboxes()[0]!
    assert.equal(checkbox.properties.checked, false)
    assert.notEqual(checkbox.properties.disabled, true, "unknown evidence must not prevent consent")
    checkbox.focus()
    assert.equal(checkbox.ownerDocument.activeElement, checkbox)
    assert.equal(mounted.tickMode(0, true), false, "the native checkbox must keep the saved value while writing")
    assert.deepEqual(mounted.mutations(), [{
      type: "subscription_spend_consent.save", profileId: "personal", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1,
      clientSnapshotPosition: 1, envelopeIds: ["prepaid", "automatic"], reviewedEnvelopeIds: ["prepaid"], acceptedEnvelopeIds: ["prepaid"],
    }])
    assert.equal(checkbox.properties["aria-busy"], true)
    assert.notEqual(checkbox.properties.disabled, true, "a saving checkbox must remain natively enabled to retain keyboard focus")
    assert.equal(checkbox.properties["aria-disabled"], true)
    assert.equal(checkbox.ownerDocument.activeElement, checkbox)
    mounted.tickMode(1, false)
    assert.equal(mounted.mutations().length, 1, "saving holds the other modes without disabling their native inputs")
    assert.match(mounted.text(), /Saving…/)
    assert.ok(!mounted.buttonLabels().includes("Save"))
    mounted.publishConsent(accepted)
    pending.resolve({ kind: "committed", consent: accepted })
    await mounted.consentSettled()
    assert.equal(mounted.checkboxes()[0], checkbox)
    assert.equal(checkbox.properties.checked, true)
    assert.equal(checkbox.properties["aria-busy"], undefined)
    assert.equal(checkbox.ownerDocument.activeElement, checkbox)

    response = Promise.resolve({ kind: "storage-failure" })
    assert.equal(mounted.tickMode(0, false), true)
    await mounted.consentSettled()
    assert.equal(mounted.checkboxes()[0], checkbox)
    assert.equal(checkbox.properties.checked, true)
    assert.deepEqual(mounted.mutations().at(-1), {
      type: "subscription_spend_consent.save", profileId: "personal", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 2,
      clientSnapshotPosition: 1, envelopeIds: ["prepaid", "automatic"], reviewedEnvelopeIds: ["prepaid"], acceptedEnvelopeIds: [],
    })
    assert.equal(mounted.reports().at(-1)?.severity, "warning")
    assert.match(mounted.reports().at(-1)!.message, /could not save paid-use settings/)
  } finally { mounted.dispose() }
})

test("the shared Authentication sheet submits and settles browser completion", async () => {
  const mounted = mountProviderBrowserLogin()
  try {
    await mounted.ready()
    // A browser opens a page only inside a tap, and the login answer arrives after the tap ended, so nothing opens
    // until the person taps the step's primary action, which opens the page inside that tap.
    assert.deepEqual(mounted.opened(), [])
    assert.equal(mounted.buttonClass(BROWSER_LOGIN_COPY.open), "primary")
    mounted.clickButton(BROWSER_LOGIN_COPY.open)
    assert.deepEqual(mounted.opened(), ["https://provider.example/authorize"])
    // One field takes either the code that the provider's page shows or the local address that it opened.
    assert.equal(mounted.inputLabel(), "Code or address")
    assert.equal(mounted.finishDisabled(), true)

    mounted.typeCompletion("http://localhost/auth/callback?code=secret-code&state=expected")
    assert.equal(mounted.finishDisabled(), false)
    mounted.submit()
    await mounted.ready()

    const mutation = mounted.mutations().find((candidate) => candidate.type === "auth.login.complete")
    assert.ok(mutation)
    assert.equal(mutation.operationId, "browser-operation")
    assert.notEqual(typeof mutation.input, "string")
    assert.deepEqual(mounted.completionInputs(), ["http://localhost/auth/callback?code=secret-code&state=expected"])
    assert.equal(mounted.finishDisabled(), true)
    assert.match(mounted.text(), /Finishing login/)

    await mounted.settleFailure("OAuth state mismatch")
    assert.doesNotMatch(mounted.text(), /Finishing login/)
    assert.deepEqual(mounted.reports(), [{
      severity: "warning",
      message: "Flywheel could not connect ChatGPT: OAuth state mismatch. Log in again.",
    }])
  } finally {
    mounted.dispose()
  }
})

test("the shared Authentication sheet offers the complete provider link and waits without a code", async () => {
  const mounted = mountProviderBrowserLogin({})
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Waiting for ChatGPT/)
    assert.doesNotMatch(mounted.text(), /Enter this code/)
    assert.deepEqual(mounted.buttonLabels().filter((label) => label === "Open the page" || label === "Copy code"), ["Open the page"])
    mounted.clickButton("Open the page")
    assert.deepEqual(mounted.opened(), ["https://accounts.x.ai/oauth2/device?user_code=ABCD-1234"])
  } finally {
    mounted.dispose()
  }
})

test("the shared Authentication sheet keeps the code and Copy code when a device code is supplied", async () => {
  const mounted = mountProviderBrowserLogin({ userCode: "ABCD-1234" })
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Enter this code on the ChatGPT page/)
    assert.match(mounted.text(), /ABCD-1234/)
    assert.match(mounted.text(), /Waiting for ChatGPT/)
    assert.deepEqual(mounted.buttonLabels().filter((label) => label === "Open the page" || label === "Copy code"), ["Copy code", "Open the page"])
    mounted.clickButton("Open the page")
    assert.deepEqual(mounted.opened(), ["https://accounts.x.ai/oauth2/device?user_code=ABCD-1234"])
  } finally {
    mounted.dispose()
  }
})

test("the shared Authentication sheet asks a flow's pre-flight question and continues with the step the answer gets", async () => {
  const prompt = { message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com", allowEmpty: true }
  const mounted = mountProviderBrowserLogin({ userCode: "ABCD-1234" }, undefined, undefined, prompt)
  try {
    await mounted.ready()
    assert.deepEqual(mounted.mutations(), [{ type: "auth.login", providerId: "chatgpt", profileId: "personal" }])
    assert.match(mounted.text(), /GitHub Enterprise URL\/domain/)
    mounted.typePromptAnswer("  company.ghe.com  ")
    mounted.submit()
    await mounted.ready()
    assert.deepEqual(mounted.mutations().at(-1), { type: "auth.login.answer", providerId: "chatgpt", operationId: "device-operation", answer: "company.ghe.com" })
    assert.match(mounted.text(), /ABCD-1234/)
    mounted.clickButton("Cancel")
    assert.deepEqual(mounted.mutations().at(-1), { type: "auth.login.cancel", operationId: "device-operation" })
  } finally {
    mounted.dispose()
  }
})

test("the shared Authentication sheet asks before a paid account replaces the free-plan account: Replace confirms, Keep free account stores nothing (PI-MODEL-038)", async () => {
  const question = "This will replace your attached free subscription because we only allow multiple copies of paid subscriptions."
  const replacing = mountProviderBrowserLogin()
  try {
    await replacing.ready()
    await replacing.ask(question)
    assert.match(replacing.text(), /This will replace your attached free subscription/)
    replacing.clickButton("Replace")
    assert.match(replacing.text(), /Replacing the free-plan account/)
    await replacing.ready()
    assert.deepEqual(replacing.mutations().at(-1), { type: "auth.login.answer", providerId: "chatgpt", operationId: "browser-operation", answer: "confirm" })
    assert.deepEqual(replacing.reports(), [{ severity: "info", message: "Connected to ChatGPT." }])
  } finally {
    replacing.dispose()
  }
  const keeping = mountProviderBrowserLogin()
  try {
    await keeping.ready()
    await keeping.ask(question)
    keeping.clickButton("Keep free account")
    await keeping.ready()
    assert.deepEqual(keeping.mutations().at(-1), { type: "auth.login.cancel", operationId: "browser-operation" })
    assert.deepEqual(keeping.reports(), [{ severity: "info", message: "ChatGPT was not connected, and the free-plan account stays. Nothing was stored." }])
    assert.doesNotMatch(keeping.text(), /This will replace/)
  } finally {
    keeping.dispose()
  }
})

test("the shared Authentication sheet shows a free-plan refusal as the runtime states it, with no Log in again (PI-MODEL-038)", async () => {
  const mounted = mountProviderBrowserLogin()
  try {
    await mounted.ready()
    const refusal = "This ChatGPT account is on a free plan, and this profile already holds a ChatGPT account. Only paid accounts rotate, so a free-plan account can be the only ChatGPT account of a profile. Nothing was stored."
    await mounted.settleFailure(refusal, true)
    assert.deepEqual(mounted.reports(), [{ severity: "warning", message: `Flywheel could not connect ChatGPT: ${refusal}` }])
  } finally {
    mounted.dispose()
  }
})
