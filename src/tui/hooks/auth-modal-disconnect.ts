import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"
import type { AuthProviderAccountStatus } from "../../protocol/auth-status-protocol-types.js"
import type { ListModalKeyEvent } from "../components/modal-list-keys.js"
import { soleAccount, type AuthRow, type ProviderOption } from "./auth-modal-options.js"

/** The provider, or the one account of it, that a Disconnect waits on the person to confirm. */
export interface DisconnectTarget {
  readonly providerId: CredentialProviderId
  readonly instanceId?: string
}

/** A Disconnect target resolved against the published providers. */
export interface DisconnectConfirmation {
  readonly option: ProviderOption
  readonly account?: AuthProviderAccountStatus
}

/** The target as the published providers show it now, or undefined when it has left them. */
export function resolveDisconnect(providers: readonly ProviderOption[], target: DisconnectTarget | undefined): DisconnectConfirmation | undefined {
  if (target === undefined) return undefined
  const option = providers.find((candidate) => candidate.id === target.providerId)
  if (option === undefined) return undefined
  if (target.instanceId === undefined) return { option }
  const account = option.accounts.find((candidate) => candidate.instanceId === target.instanceId)
  return account === undefined ? undefined : { option, account }
}

interface AuthModalDisconnectDeps {
  readonly providers: () => readonly ProviderOption[]
  readonly target: () => DisconnectTarget | undefined
  readonly setTarget: (target: DisconnectTarget | undefined) => void
  /** Runs the disconnect that the person confirmed. */
  readonly disconnect: (confirmation: DisconnectConfirmation) => void
}

/**
 * The Disconnect question. A disconnect asks first, as it does in every client: a login that an external program
 * owns ends in that program for every app that uses it, so the question states that consequence. The
 * question covers the open view without replacing it, so Cancel returns to the same list row or settings page.
 */
export function createAuthModalDisconnect(deps: AuthModalDisconnectDeps) {
  const confirmation = (): DisconnectConfirmation | undefined => resolveDisconnect(deps.providers(), deps.target())

  function request(option: ProviderOption, account?: AuthProviderAccountStatus): void {
    deps.setTarget({ providerId: option.id, ...(account === undefined ? {} : { instanceId: account.instanceId }) })
  }

  /** Asks about the list row that d acts on: an account, a subscription's one account, or a provider's stored
   *  credential. Returns false when the row has nothing to disconnect. */
  function requestRow(row: AuthRow | undefined): boolean {
    if (row?.kind === "account") { request(row.option, row.account); return true }
    if (row?.kind !== "provider") return false
    const account = soleAccount(row.option)
    if (row.option.kind === "subscription") {
      if (account === undefined) return false
      request(row.option, account)
      return true
    }
    if (row.option.source !== "stored_key" && row.option.source !== "oauth") return false
    request(row.option)
    return true
  }

  function confirm(): void {
    const confirmed = confirmation()
    deps.setTarget(undefined)
    if (confirmed !== undefined) deps.disconnect(confirmed)
  }

  function cancel(): void {
    deps.setTarget(undefined)
  }

  /** The question owns the keyboard until it is answered: y confirms, n or Escape cancels, and no other key acts. */
  function handleKey(event: ListModalKeyEvent): boolean {
    if (confirmation() === undefined) return false
    event.preventDefault?.()
    const key = event.name.toLowerCase()
    if (key === "y") confirm()
    else if (key === "n" || key === "escape") cancel()
    return true
  }

  return { confirmation, request, requestRow, confirm, cancel, handleKey }
}
