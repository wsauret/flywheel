import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"

import type { SheetFocus } from "../../../src/protocol/client/host-contract.js"
import { observeProviderSheetFocus } from "./sheets/providers-sheet.js"

test("provider focus requests focus without starting authentication and repeat while mounted", async () => {
  await createRoot(async (dispose) => {
    const [intent, setIntent] = createSignal<SheetFocus | undefined>({ kind: "focus-provider", providerId: "chatgpt" })
    const focused: string[] = []
    const connected: string[] = []
    observeProviderSheetFocus(intent, (providerId) => focused.push(providerId), (providerId) => connected.push(providerId), () => {}, () => {})
    await Promise.resolve()

    setIntent({ kind: "focus-provider", providerId: "github_copilot" })
    await Promise.resolve()
    setIntent({ kind: "focus-provider", providerId: "chatgpt" })
    await Promise.resolve()

    assert.deepEqual(focused, ["chatgpt", "github_copilot", "chatgpt"])
    assert.deepEqual(connected, [])
    dispose()
  })
})

test("exact paid-use review requests repeat while mounted without starting authentication", async () => {
  await createRoot(async (dispose) => {
    const first = { kind: "review-paid-use", providerId: "chatgpt", accountCorrelationId: "account-a", envelopeId: "paid-a" } as const
    const second = { kind: "review-paid-use", providerId: "github_copilot", accountCorrelationId: "account-b", envelopeId: "paid-b" } as const
    const [intent, setIntent] = createSignal<SheetFocus | undefined>(first)
    const focused: string[] = []
    const connected: string[] = []
    const reviewed: SheetFocus[] = []
    observeProviderSheetFocus(
      intent,
      (providerId) => focused.push(providerId),
      (providerId) => connected.push(providerId),
      (review) => reviewed.push(review),
      () => {},
    )
    await Promise.resolve()

    setIntent(second)
    await Promise.resolve()
    setIntent(first)
    await Promise.resolve()

    assert.deepEqual(reviewed, [first, second, first])
    assert.deepEqual(focused, [])
    assert.deepEqual(connected, [])
    dispose()
  })
})

test("a reconnect intent targets its question without starting an ordinary provider login", async () => {
  await createRoot(async (dispose) => {
    const question = { questionId: "q", providerId: "claude_agent_sdk", instanceId: "b", profileId: "b", profileDisplayName: "Background", providerDisplayName: "Anthropic Subscription", accountDisplayName: "person@example.invalid" }
    const connected: string[] = []
    const recovered: unknown[] = []
    observeProviderSheetFocus(() => ({ kind: "reconnect-account", question }), () => {}, (id) => connected.push(id), () => {}, (target) => recovered.push(target))
    await Promise.resolve()
    assert.deepEqual(recovered, [question])
    assert.deepEqual(connected, [])
    dispose()
  })
})
