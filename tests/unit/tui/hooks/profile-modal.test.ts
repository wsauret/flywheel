import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import type { MutationResult } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import type { RuntimeAuthProfileSelectMutation } from "../../../../src/protocol/auth-profile-selection-protocol-types.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { useProfileModal, type ProfileModalHook } from "../../../../src/tui/hooks/use-profile-modal.js"
import { createAuthProfileSelection } from "../../../../src/tui/hooks/auth-profile-selection.js"

function authView(overrides: Partial<RuntimeAuthView["profile"]> = {}): RuntimeAuthView {
  return {
    providers: [],
    warnings: [],
    authFilePath: "/profiles/default/auth.json",
    subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
    profile: {
      id: "default",
      displayName: "Default",
      source: "sticky",
      availableProfiles: [
        { id: "default", displayName: "Default" },
        { id: "work", displayName: "Work Account" },
      ],
      ...overrides,
    },
  }
}

function harness(
  initialAuth: RuntimeAuthView | undefined,
  run: (context: {
    modal: ProfileModalHook
    modals: ReturnType<typeof createModalStack>
    dispatch: ReturnType<typeof mock>
    showToast: ReturnType<typeof mock>
    flush: () => Promise<void>
  }) => void | Promise<void>,
  dispatchImpl?: () => Promise<MutationResult<RuntimeAuthProfileSelectMutation>>,
  foregroundSessionId: string | null = "session-1",
): void {
  createRoot((dispose) => {
    const modals = createModalStack()
    const showToast = mock(() => {})
    // Returns the impl's promise as is: the flush below allows only two promise turns.
    const dispatch = mock((command: RuntimeAuthProfileSelectMutation) => dispatchImpl ? dispatchImpl() : Promise.resolve({ id: command.id }))
    const [auth] = createSignal(initialAuth)
    const [foreground] = createSignal(foregroundSessionId ?? undefined)
    const authProfileSelection = createAuthProfileSelection({ appService: { dispatch: runtimeDispatch({ "auth.profile.select": dispatch }) }, foregroundSessionId: foreground, showToast })
    const modal = useProfileModal({
      auth,
      authProfileSelection,
      modal: modals,
      renderModal: () => "mock-profile-modal",
      showToast,
    })
    const flush = async (): Promise<void> => {
      await Promise.resolve()
      await Promise.resolve()
    }
    try {
      const outcome = run({ modal, modals, dispatch, showToast, flush })
      if (outcome instanceof Promise) throw new Error("harness run must be synchronous; await inside expectations via flush")
    } finally {
      dispose()
    }
  })
}

function rowIndexOf(modal: ProfileModalHook, id: string): number {
  const row = modal.profileModalResult().rows.find((candidate) => candidate.kind === "option" && candidate.option.value === id)
  if (row?.kind !== "option") throw new Error(`Profile row not found: ${id}`)
  return row.rowIndex
}

describe("useProfileModal", () => {
  it("switches directly on an exact case-insensitive display-name match", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView(), ({ modal, modals, dispatch, showToast, flush }) => {
      modal.openProfileSwitcher("  work account ")
      pending = flush().then(() => {
        expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "session", sessionId: "session-1" }, id: "work" })
        expect(showToast).toHaveBeenCalledWith({ message: "Auth profile set to Work Account", variant: "success" })
        expect(modals.stack.length).toBe(0)
      })
    })
    await pending
  })

  it("uses the defaults scope when no tab is foreground", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView(), ({ modal, dispatch, flush }) => {
      modal.openProfileSwitcher("work account")
      pending = flush().then(() => {
        expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "defaults" }, id: "work" })
      })
    }, undefined, null)
    await pending
  })

  it("surfaces a scoped service warning without reporting success", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView(), ({ modal, showToast, flush }) => {
      modal.openProfileSwitcher("work account")
      pending = flush().then(() => {
        expect(showToast).toHaveBeenCalledWith({ message: "Default selected, but this tab was not updated", variant: "warning", duration: 8000 })
        expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "success" }))
      })
    }, async () => ({ id: "work", warning: "Default selected, but this tab was not updated" }))
    await pending
  })

  it("opens the modal when no argument is given", () => {
    harness(authView(), ({ modal, modals, dispatch }) => {
      modal.openProfileSwitcher()
      expect(modals.stack.length).toBe(1)
      expect(dispatch).not.toHaveBeenCalled()
      expect(modal.profileModalCursor()).toBe(rowIndexOf(modal, "default"))
    })
  })

  it("opens the modal when the name does not match", () => {
    harness(authView(), ({ modal, modals, dispatch }) => {
      modal.openProfileSwitcher("nope")
      expect(modals.stack.length).toBe(1)
      expect(dispatch).not.toHaveBeenCalled()
    })
  })

  it("treats the active profile name as a no-op", () => {
    harness(authView(), ({ modal, modals, dispatch, showToast }) => {
      modal.openProfileSwitcher("default")
      expect(dispatch).not.toHaveBeenCalled()
      expect(modals.stack.length).toBe(0)
      expect(showToast).toHaveBeenCalledWith({ message: "Default is already the active profile", variant: "info" })
    })
  })

  it("reports pending auth instead of opening the modal", () => {
    harness(undefined, ({ modal, modals, dispatch, showToast }) => {
      modal.openProfileSwitcher("work account")
      expect(dispatch).not.toHaveBeenCalled()
      expect(modals.stack.length).toBe(0)
      expect(showToast).toHaveBeenCalledWith({
        message: "Auth profiles are unavailable until the runtime publishes its auth view",
        variant: "error",
      })
    })
  })

  it("reports the runtime error and no success on a refused switch", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView(), ({ modal, showToast, flush }) => {
      modal.openProfileSwitcher("work account")
      pending = flush().then(() => {
        expect(showToast).toHaveBeenCalledWith({ message: "profile is locked", variant: "error" })
        expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "success" }))
      })
    }, async () => ({ ok: false, error: "profile is locked" }))
    await pending
  })

  it("reports a rejected dispatch as an error toast", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView(), ({ modal, showToast, flush }) => {
      modal.openProfileSwitcher("work account")
      pending = flush().then(() => {
        expect(showToast).toHaveBeenCalledWith({ message: "runtime unreachable", variant: "error" })
        expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ variant: "success" }))
      })
    }, async () => {
      throw new Error("runtime unreachable")
    })
    await pending
  })

  it("reports the environment lock from the runtime", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView({ source: "environment" }), ({ modal, modals, dispatch, showToast, flush }) => {
      modal.openProfileSwitcher("work account")
      pending = flush().then(() => {
        expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "session", sessionId: "session-1" }, id: "work" })
        expect(modals.stack.length).toBe(0)
        expect(showToast).toHaveBeenCalledWith({ message: "cannot switch the environment-selected auth profile", variant: "error" })
      })
    }, async () => {
      throw new Error("cannot switch the environment-selected auth profile")
    })
    await pending
  })

  it("switches and closes when a different profile row is clicked", async () => {
    let pending: Promise<void> = Promise.resolve()
    harness(authView(), ({ modal, modals, dispatch, flush }) => {
      modal.openProfileSwitcher()
      modal.selectProfileRow(rowIndexOf(modal, "work"))
      expect(modals.stack.length).toBe(0)
      pending = flush().then(() => {
        expect(dispatch).toHaveBeenCalledWith({ type: "auth.profile.select", scope: { kind: "session", sessionId: "session-1" }, id: "work" })
      })
    })
    await pending
  })

  it("closes without dispatching when the active profile row is clicked", () => {
    harness(authView(), ({ modal, modals, dispatch }) => {
      modal.openProfileSwitcher()
      modal.selectProfileRow(rowIndexOf(modal, "default"))
      expect(modals.stack.length).toBe(0)
      expect(dispatch).not.toHaveBeenCalled()
    })
  })
})
