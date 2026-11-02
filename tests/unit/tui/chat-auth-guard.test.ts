import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test"
import { createSignal } from "solid-js"
import { createCommandDispatch } from "../../../src/tui/commands/command-dispatch.js"
import { PROVIDER_SETUP_WAIT_MS, type ProviderSetup } from "../../../src/protocol/client/provider-setup.js"
import type { CommandDeps } from "../../../src/tui/hooks/use-commands.js"
import { useCommands } from "../../../src/tui/hooks/use-commands.js"
import type { SettingsDestination } from "../../../src/tui/settings-destination.js"

const originalDialogPolicy = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
beforeEach(() => { process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "0" })
afterEach(() => {
  if (originalDialogPolicy === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = originalDialogPolicy
})

function createHarness(overrides: { showToast?: CommandDeps["showToast"]; openAuthModal?: () => void; sendMessage?: CommandDeps["sendMessage"]; providerSetup?: () => ProviderSetup; openSubscriptionSpendReview?: () => boolean } = {}) {
  const foregroundId = (): string | undefined => "chat-abc"
  const signals = {
    foregroundId,
    foregroundTarget: () => ({ kind: "session" as const, sessionId: "chat-abc" }),
    sessionInputMode: () => ({ kind: "chat" as const }),
    sessionState: () => "active" as const,
  }
  const showToast = overrides.showToast ?? mock(() => {})
  const openAuthModal = overrides.openAuthModal ?? mock(() => {})
  const openSettingsDestination = mock(async (destination: SettingsDestination) => {
    if (destination.kind === "auth") openAuthModal()
  })
  const dispatch = createCommandDispatch({
    definitions: () => [],
    context: undefined,
    showToast,
    offCommands: () => [],
    catalog: { known: () => true, arrived: Promise.resolve() },
  })
  const deps: CommandDeps = {
    signals,
    dispatch,
    showToast,
    sendMessage: overrides.sendMessage ?? mock(async () => {}),
    startChat: mock(async () => ({ kind: "foregrounded" as const, sessionId: "created" })),
    openSettingsDestination,
    providerSetup: overrides.providerSetup ?? (() => "usable"),
    openSubscriptionSpendReview: overrides.openSubscriptionSpendReview ?? (() => false),
  }
  return useCommands(deps)
}

describe("chat input — auth guard", () => {
  it("blocks chat send with a toast and opens auth modal when no providers configured", () => {
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const openAuthModal = mock(() => {})
    const sendMessage = mock(async () => {})
    const { handleComposerSubmit } = createHarness({ showToast, openAuthModal, sendMessage, providerSetup: () => "none" })

    const accepted = handleComposerSubmit("hello there")

    expect(accepted).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(openAuthModal).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0]?.[0].variant).toBe("warning")
    expect(showToast.mock.calls[0]?.[0].message).toContain("/auth")
  })

  it("does not block when at least one provider is configured", () => {
    const sendMessage = mock(async () => {})
    const openAuthModal = mock(() => {})
    const { handleComposerSubmit } = createHarness({ sendMessage, openAuthModal, providerSetup: () => "usable" })

    handleComposerSubmit("hello there")

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(openAuthModal).not.toHaveBeenCalled()
  })

  it("decides a send made before the provider list is known once the list arrives empty", async () => {
    process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "1"
    const [setup, setSetup] = createSignal<ProviderSetup>("loading")
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const sendMessage = mock(async () => {})
    const { handleComposerSubmit } = createHarness({ showToast, sendMessage, providerSetup: setup })

    const result = handleComposerSubmit("hello there")
    if (typeof result === "boolean") throw new Error("a send before the provider list is known must stay pending")
    expect(showToast).not.toHaveBeenCalled()

    setSetup("none")
    expect(await result.accepted).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0]?.[0].message).toBe("No model provider is ready; use /auth")
  })

  it("sends a message made before the provider list is known once a provider is known", async () => {
    const [setup, setSetup] = createSignal<ProviderSetup>("loading")
    const sendMessage = mock(async (_sessionId: string, _input: unknown) => {})
    const { handleComposerSubmit } = createHarness({ sendMessage, providerSetup: setup })

    const result = handleComposerSubmit("hello there")
    if (typeof result === "boolean") throw new Error("a send before the provider list is known must stay pending")
    expect(sendMessage).not.toHaveBeenCalled()

    setSetup("usable")
    expect(await result.accepted).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0]?.[0]).toBe("chat-abc")
  })

  it("sends a message made before the provider list is known when the list does not arrive within the auth read deadline", async () => {
    jest.useFakeTimers()
    try {
      const sendMessage = mock(async (_sessionId: string, _input: unknown) => {})
      const { handleComposerSubmit } = createHarness({ sendMessage, providerSetup: () => "loading" })

      const result = handleComposerSubmit("hello there")
      if (typeof result === "boolean") throw new Error("a send before the provider list is known must stay pending")
      jest.advanceTimersByTime(PROVIDER_SETUP_WAIT_MS - 1)
      await Promise.resolve()
      expect(sendMessage).not.toHaveBeenCalled()

      jest.advanceTimersByTime(1)
      expect(await result.accepted).toBe(true)
      expect(sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("suppresses automatic auth without admitting unauthenticated input", () => {
    process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "1"
    const showToast = mock((_toast: { message: string; variant: string }) => {})
    const openAuthModal = mock(() => {})
    const sendMessage = mock(async () => {})
    const { handleComposerSubmit } = createHarness({ showToast, openAuthModal, sendMessage, providerSetup: () => "none" })

    expect(handleComposerSubmit("hello there")).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(openAuthModal).not.toHaveBeenCalled()
    expect(showToast.mock.calls[0]?.[0].message).toContain("/auth")
    expect(showToast.mock.calls[0]?.[0].message).not.toContain("opening")
  })

  it("suppresses pre-submission consent review without changing runtime delivery", () => {
    process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "1"
    const sendMessage = mock(async () => {})
    const openSubscriptionSpendReview = mock(() => true)
    const { handleComposerSubmit } = createHarness({ sendMessage, openSubscriptionSpendReview })

    expect(handleComposerSubmit("hello there")).toBe(true)
    expect(openSubscriptionSpendReview).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("keeps input pending and opens consent review before starting a model turn", () => {
    const sendMessage = mock(async () => {})
    const openSubscriptionSpendReview = mock(() => true)
    const { handleComposerSubmit } = createHarness({ sendMessage, openSubscriptionSpendReview })

    expect(handleComposerSubmit("hello there")).toBe(false)
    expect(openSubscriptionSpendReview).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("keeps local commands available while paid review is pending", () => {
    const openSubscriptionSpendReview = mock(() => true)
    const { handleComposerSubmit } = createHarness({ openSubscriptionSpendReview })

    expect(handleComposerSubmit("/status")).toMatchObject({ accepted: expect.any(Promise) })
    expect(openSubscriptionSpendReview).not.toHaveBeenCalled()
  })
})
