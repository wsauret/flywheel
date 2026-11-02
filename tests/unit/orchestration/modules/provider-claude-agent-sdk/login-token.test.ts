import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loginKeychainPath } from "../../../../../src/infra/macos-keychain.js";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js";
import { KEYCHAIN_SERVICE_PREFIX, keychainService, loginToken } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-token.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();

/** A login folder with the token-free account record, as the engine leaves it after a login. */
function loginFolder(config: { readonly cachedGrowthBookFeatures?: { readonly tengu_windows_credman: boolean } } = {}): string {
  const configDir = temporaryDirectory("claude-login-token-");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person" }, ...config }));
  return configDir;
}

/** A `security` runner that answers with the given exit code, and records what it was asked. */
function securityRunner(exitCode: number, timedOut = false) {
  const asked: (readonly string[])[] = [];
  const run: OwnedCommandRunner = async (command) => {
    asked.push(command);
    const result: OwnedCommandResult = { exitCode, stdout: "", stdoutBytes: new Uint8Array(), stderr: "", timedOut };
    return result;
  };
  return { run, asked };
}

/** A macOS account whose home holds a login keychain file, which no test opens. */
function accountWithKeychain() {
  const home = temporaryDirectory("claude-login-token-home-");
  mkdirSync(join(loginKeychainPath(home), ".."), { recursive: true });
  writeFileSync(loginKeychainPath(home), "");
  return { home, user: "tester" };
}

const account = { home: "/scratch/person", user: "tester" };
const unlocked = () => true;

describe("whether the engine holds a token for a login, found without reading a secret", () => {
  test("names the keychain item that the engine names for the login folder: the first 8 hex of the path's SHA-256", () => {
    // Engine 2.1.296 with CLAUDE_CONFIG_DIR=/scratch/login asks `security` for this item (a captured call).
    expect(keychainService("/scratch/login")).toBe(`${KEYCHAIN_SERVICE_PREFIX}${new Bun.CryptoHasher("sha256").update("/scratch/login").digest("hex").slice(0, 8)}`);
  });

  test("a credentials file is a token by its existence alone, on every platform, and nothing runs", async () => {
    const configDir = loginFolder();
    writeFileSync(join(configDir, ".credentials.json"), "not read");
    const { run, asked } = securityRunner(0);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(await loginToken(configDir, { platform, account, run, keychainUnlocked: unlocked })).toEqual({ kind: "present", store: "file" });
    }
    expect(asked).toEqual([]);
  });

  test("on macOS, the account's login keychain is searched for the item by its attributes only, once its state says it is unlocked", async () => {
    const configDir = loginFolder();
    const person = accountWithKeychain();
    const found = securityRunner(0);
    const checked: string[] = [];
    const state = (path: string) => { checked.push(path); return true; };
    expect(await loginToken(configDir, { platform: "darwin", account: person, run: found.run, keychainUnlocked: state })).toEqual({ kind: "present", store: "keychain" });
    expect(checked).toEqual([loginKeychainPath(person.home)]);
    // No -g and no -w: the command prints the item's attributes, never its secret, so it needs no access and asks
    // nothing. The keychain argument limits the search to the keychain whose state was checked.
    expect(found.asked).toEqual([["/usr/bin/security", "find-generic-password", "-a", "tester", "-s", keychainService(configDir), loginKeychainPath(person.home)]]);

    expect(await loginToken(configDir, { platform: "darwin", account: person, run: securityRunner(44).run, keychainUnlocked: unlocked })).toEqual({ kind: "absent" });
    const profileLogin = join(person.home, ".flywheel", "auth", "profiles", "work", LOGIN_ACCOUNTS_DIRECTORY, "shared");
    mkdirSync(profileLogin, { recursive: true });
    const shared = securityRunner(0);
    expect(await loginToken(profileLogin, { platform: "darwin", account, run: shared.run, keychainUnlocked: unlocked })).toEqual({ kind: "present", store: "keychain" });
    expect(shared.asked).toEqual([["/usr/bin/security", "find-generic-password", "-a", "tester", "-s", keychainService(profileLogin), loginKeychainPath(person.home)]]);
  });

  test("on macOS, an account with no login keychain holds no keychain token, and nothing runs", async () => {
    const { run, asked } = securityRunner(0);
    expect(await loginToken(loginFolder(), { platform: "darwin", account, run, keychainUnlocked: unlocked })).toEqual({ kind: "absent" });
    expect(asked).toEqual([]);
  });

  test("on macOS, a locked keychain or one whose state is unknown is never searched, and a failed or silent lookup or no program launch leaves the token unchecked", async () => {
    const configDir = loginFolder();
    const person = accountWithKeychain();
    // A search of a locked keychain can show the dialog that asks for its password, so none runs.
    const locked = securityRunner(0);
    expect(await loginToken(configDir, { platform: "darwin", account: person, run: locked.run, keychainUnlocked: () => false })).toEqual({ kind: "unchecked", reason: "the login keychain is locked" });
    expect(await loginToken(configDir, { platform: "darwin", account: person, run: locked.run, keychainUnlocked: () => undefined })).toEqual({ kind: "unchecked", reason: "the login keychain's state could not be read" });
    expect(locked.asked).toEqual([]);
    expect(await loginToken(configDir, { platform: "darwin", account: person, run: securityRunner(51).run, keychainUnlocked: unlocked }))
      .toEqual({ kind: "unchecked", reason: "the keychain lookup exited with code 51" });
    expect(await loginToken(configDir, { platform: "darwin", account: person, run: securityRunner(0, true).run, keychainUnlocked: unlocked }))
      .toEqual({ kind: "unchecked", reason: "the keychain did not answer within 5 s" });
    expect(await loginToken(configDir, { platform: "darwin", account: person, run: undefined, keychainUnlocked: unlocked }))
      .toEqual({ kind: "unchecked", reason: "this runtime starts no program" });
  });

  test("on Linux, and on Windows unless the login enabled Credential Manager, the credentials file is the only store", async () => {
    const { run, asked } = securityRunner(0);
    const probe = (platform: NodeJS.Platform) => ({ platform, account, run, keychainUnlocked: unlocked });
    expect(await loginToken(loginFolder(), probe("linux"))).toEqual({ kind: "absent" });
    expect(await loginToken(loginFolder(), probe("win32"))).toEqual({ kind: "absent" });
    expect(await loginToken(loginFolder({ cachedGrowthBookFeatures: { tengu_windows_credman: true } }), probe("win32")))
      .toEqual({ kind: "unchecked", reason: "the engine can keep it in Windows Credential Manager, which Flywheel does not search" });
    expect(asked).toEqual([]);
  });
});
