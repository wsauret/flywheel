import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loginKeychainPath } from "../../../infra/macos-keychain.js";
import type { OsAccount } from "../../../infra/os-account.js";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";
import { cliLogin } from "./cli-login.js";
import { loginOwnerHome } from "./cli-environment.js";
import { credentialsFilePath } from "./names.js";

/** A keychain lookup ends in milliseconds. One that does not answer is waiting for a person, so it is ended. */
const KEYCHAIN_BOUND_MS = 5_000;
/** `security find-generic-password` exits with this code when no item matches. */
const ITEM_NOT_FOUND = 44;

/** Whether the engine holds a token for a login, and where. `unchecked` names why Flywheel could not tell. */
export type LoginToken =
  | { readonly kind: "present"; readonly store: "file" | "keychain" }
  | { readonly kind: "absent" }
  | { readonly kind: "unchecked"; readonly reason: string };

/** What a token check needs of the machine: its platform, the OS account whose login keychain holds the engine's
 *  items, the owned-command runner, which is absent in a runtime that starts no program, and the state of a keychain
 *  file (`keychainUnlocked`), which never prompts. */
export interface TokenProbe {
  readonly platform: NodeJS.Platform;
  readonly account: OsAccount;
  readonly run: OwnedCommandRunner | undefined;
  readonly keychainUnlocked: (path: string) => boolean | undefined;
}

/** The prefix of the macOS keychain service name under which engine 2.1.296 keeps a login's token. */
export const KEYCHAIN_SERVICE_PREFIX = "Claude Code-credentials-";

/** The macOS keychain service under which the engine keeps the token of the login in `configDir`. Engine 2.1.296
 *  names it `KEYCHAIN_SERVICE_PREFIX` and the first 8 hex digits of the SHA-256 of the folder's path, and names the
 *  OS user as its account (a captured `security` call). */
export function keychainService(configDir: string): string {
  return `${KEYCHAIN_SERVICE_PREFIX}${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

/**
 * Whether the engine holds a token for the login in `configDir`, found without reading any secret. A credentials file
 * counts by its existence. On macOS, the engine's `security` runs in the home that owns the login (the login's keychain
 * launcher), so this check uses the same login keychain. A search of a locked keychain can show the
 * dialog that asks for its password, so the login keychain is searched only when its own state says that it is
 * unlocked, and the search names that keychain, so no other keychain is searched. The lookup has no `-g` and no `-w`:
 * `security` prints the item's attributes and no secret, needs no access to the item, and shows no prompt. On Linux,
 * and on Windows unless the login enabled Credential Manager, the engine keeps the token only in the credentials file.
 */
export async function loginToken(configDir: string, probe: TokenProbe): Promise<LoginToken> {
  if (existsSync(credentialsFilePath(configDir))) return { kind: "present", store: "file" };
  if (probe.platform === "darwin") return await keychainToken(configDir, probe);
  if (probe.platform === "win32" && cliLogin(configDir)?.windowsCredentialManager === true) {
    return { kind: "unchecked", reason: "the engine can keep it in Windows Credential Manager, which Flywheel does not search" };
  }
  return { kind: "absent" };
}

async function keychainToken(configDir: string, { account, run, keychainUnlocked }: TokenProbe): Promise<LoginToken> {
  const keychain = loginKeychainPath(loginOwnerHome(configDir, account.home));
  if (!existsSync(keychain)) return { kind: "absent" };
  if (run === undefined) return { kind: "unchecked", reason: "this runtime starts no program" };
  const unlocked = keychainUnlocked(keychain);
  if (unlocked === undefined) return { kind: "unchecked", reason: "the login keychain's state could not be read" };
  if (!unlocked) return { kind: "unchecked", reason: "the login keychain is locked" };
  const found = await run(["/usr/bin/security", "find-generic-password", "-a", account.user, "-s", keychainService(configDir), keychain], { timeoutMs: KEYCHAIN_BOUND_MS });
  if (found.timedOut) return { kind: "unchecked", reason: `the keychain did not answer within ${KEYCHAIN_BOUND_MS / 1000} s` };
  if (found.exitCode === 0) return { kind: "present", store: "keychain" };
  if (found.exitCode === ITEM_NOT_FOUND) return { kind: "absent" };
  return { kind: "unchecked", reason: `the keychain lookup exited with code ${String(found.exitCode)}` };
}
