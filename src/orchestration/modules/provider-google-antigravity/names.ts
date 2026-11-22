import { join } from "node:path"

/** The provider as a person reads it in settings and in errors. */
export const GOOGLE_ANTIGRAVITY_LABEL = "Google Antigravity"
/** The program that owns the provider's login, as a person reads it. */
export const LOGIN_PROGRAM_LABEL = "Antigravity CLI"

/** The directory, in an auth profile's directory, that holds one login directory per Google Antigravity login of
 *  that profile: `<id>/` with the login's private home, workspace, and logs. The person's own `~/.gemini` is never
 *  one of them. */
const LOGIN_ACCOUNTS_DIRECTORY = "antigravity"

/** The directory of every login of the auth profile in `authDir`. */
export function loginsDirectory(authDir: string): string {
  return join(authDir, LOGIN_ACCOUNTS_DIRECTORY)
}

/** Flywheel's token-free record of the account that a login directory holds. agy keeps the token in its own store
 *  in the login's private home; this file holds no part of it. */
export function accountRecordPath(loginDir: string): string {
  return join(loginDir, "account.json")
}
