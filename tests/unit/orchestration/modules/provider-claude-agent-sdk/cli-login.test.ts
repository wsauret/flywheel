import { describe, expect, spyOn, test } from "bun:test";
import type { FileSink } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExternalLoginPorts } from "../../../../../src/infra/llm/access-provider.js";
import type { OsAccount } from "../../../../../src/infra/os-account.js";
import type { OwnedProcess, OwnedProcessExit } from "../../../../../src/infra/owned-subprocess.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { cliLogin, cliLoginAccount, loginClaudeAccount, logoutClaudeAccount, logoutProfileClaudeAccounts, profileClaudeAccounts, type ClaudeProfile } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-login.js";
import type { LoginKey } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import type { EngineHost } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-environment.js";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { Log } from "../../../../../src/infra/log.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();
const CLI = "/scratch/bin/claude";
const STATE = "abc";
const AUTHORIZE_URL = `https://claude.com/cai/oauth/authorize?code=true&state=${STATE}`;

/** The engine host of one test: the fake engine, the test's account, no host variables, and a private directory
 *  that the login and logout commands run in. */
function engineHost(account: OsAccount): EngineHost {
  return { enginePath: CLI, account, platform: "linux", hostEnvironment: {}, timeZone: "UTC", temporaryDirectory: temporaryDirectory("claude-login-tmp-") };
}

/** The profile in `authDir` of `account`'s Flywheel home, which adds each login that ends to `forgotten`. */
function profile(authDir: string, account: OsAccount, forgotten: LoginKey[] = []): ClaudeProfile {
  return { authDir, host: engineHost(account), accountHome: account.home, forget: (login) => { forgotten.push(login); } };
}

/** Writes the CLI's global config for a login, as the CLI does: a token-free `oauthAccount` beside other state. */
function writeLogin(path: string, oauthAccount: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ numStartups: 3, projects: {}, oauthAccount }));
}

/** A scratch OS account whose own `claude` is logged in, and the auth directories of two profiles in its Flywheel
 *  home. Flywheel never reads, lists, or changes that login. */
function place() {
  const home = temporaryDirectory("claude-cli-login-");
  writeLogin(join(home, ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
  const profiles = join(home, ".flywheel", "auth", "profiles");
  return { account: { home, user: "tester" } satisfies OsAccount, authDir: join(profiles, "default"), otherAuthDir: join(profiles, "work") };
}

/** The global config of the person's own `claude`, which every test leaves as it was. */
function ownClaudeConfig(account: OsAccount): string {
  return readFileSync(join(account.home, ".claude.json"), "utf8");
}

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start(handle) { controller = handle; } });
  return { readable, write: (text: string) => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close() };
}

interface FakeCliRun {
  readonly command: readonly string[];
  readonly env: { readonly [name: string]: string | undefined };
}

/**
 * A launcher that plays the CLI's `auth login`: it prints the manual URL, waits for a pasted `code#state` line on
 * stdin, then writes `onCode`'s login into the global config of the directory it was started on and exits 0, or
 * prints a failure to stderr and exits 1 when `onCode` returns a failure. Like CLI 2.1.295, it reads every line of
 * its piped stdin, and a line that is not `code#state` gets "Invalid code" on stderr while the CLI waits on for
 * another line. `auth logout` exits with `logoutCode`.
 */
function fakeCli(account: OsAccount, onCode: (code: string) => { readonly oauthAccount: unknown } | { readonly failure: string }, logoutCode = 0) {
  const runs: FakeCliRun[] = [];
  const pasted: string[] = [];
  let terminated = 0;
  const launcher: LauncherScope = {
    spawnOwned: async (command, options) => {
      const env = options?.env ?? {};
      runs.push({ command, env });
      const stdout = stream();
      const stderr = stream();
      const exit = Promise.withResolvers<OwnedProcessExit>();
      const finish = (code: number): void => {
        stdout.close();
        stderr.close();
        exit.resolve({ code, signal: null, statusOf: "payload", ownership: "surrendered" });
      };
      const configPath = env.CLAUDE_CONFIG_DIR === undefined ? join(account.home, ".claude.json") : join(env.CLAUDE_CONFIG_DIR, ".claude.json");
      const stdin: FileSink = {
        write: (chunk) => {
          const line = (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)).trim();
          pasted.push(line);
          const [code, state] = line.split("#");
          if (!code || !state) {
            stderr.write("Invalid code. Please make sure the full code was copied.\n");
            return 0;
          }
          const outcome = onCode(line);
          if ("failure" in outcome) {
            stderr.write(`Login failed: ${outcome.failure}\n`);
            finish(1);
          } else {
            writeLogin(configPath, outcome.oauthAccount);
            stdout.write("Login successful.\n");
            finish(0);
          }
          return 0;
        },
        flush: () => 0,
        end: () => 0,
        start: () => {},
        ref: () => {},
        unref: () => {},
      };
      if (command[2] === "logout") queueMicrotask(() => finish(logoutCode));
      else {
        stdout.write("Opening browser to sign in…\n");
        stdout.write(`If the browser didn't open, visit: \u001B[1m${AUTHORIZE_URL}\u001B[22m\n`);
        stdout.write("Paste code here if prompted > ");
      }
      const owned: OwnedProcess = {
        pid: 4242, token: "token", stdin, stdout: stdout.readable, stderr: stderr.readable, exited: exit.promise,
        terminate: async () => { terminated += 1; finish(143); return await exit.promise; },
      };
      return owned;
    },
    adoptOwned: () => Promise.reject(new Error("no adoption")),
    open: () => launcher,
    close: async () => ({ settled: true }),
  };
  return { launcher, runs, pasted, terminated: () => terminated };
}

/** Login ports whose person pastes `code` once the CLI's URL is shown. */
function ports(launcher: LauncherScope, code = `pasted-code#${STATE}`) {
  const urls: string[] = [];
  const loginPorts: ExternalLoginPorts = {
    launcher,
    openBrowser: async () => true,
    onAuthorizeUrl: ({ url }) => { urls.push(url); },
    onManualCodeInput: async () => `  ${code}\n`,
  };
  return { loginPorts, urls };
}

describe("the Claude CLI's logins", () => {
  test("a separate home uses a reference to the same login and Disconnect removes only that reference", async () => {
    const { account, otherAuthDir } = place();
    const authDir = join(temporaryDirectory("claude-reference-home-"), ".flywheel", "auth", "profiles", "default");
    const configDir = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "a");
    writeLogin(join(configDir, ".claude.json"), { accountUuid: "shared", emailAddress: "shared@example.com" });
    mkdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY), { recursive: true });
    const referencePath = join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "shared.reference.json");
    writeFileSync(referencePath, JSON.stringify({ version: 1, configDir }));
    const found = profileClaudeAccounts(authDir, account.home);
    expect(found).toEqual([{ accountId: "shared", identity: "shared@example.com", configDir, referencePath }]);
    const cli = fakeCli(account, () => ({ oauthAccount: {} }));
    if (found[0] === undefined) throw new Error("reference was not found");
    await logoutClaudeAccount(profile(authDir, account), found[0].accountId, { launcher: cli.launcher });
    expect(cli.runs).toEqual([]);
    expect(existsSync(referencePath)).toBe(false);
    expect(cliLoginAccount(configDir)?.accountId).toBe("shared");
  });

  test("references refuse missing logins, invalid profile ids, foreign folders, relative paths, links, and unknown versions", () => {
    const { account, authDir, otherAuthDir } = place();
    const root = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
    mkdirSync(root, { recursive: true });
    const valid = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "a");
    writeLogin(join(valid, ".claude.json"), { accountUuid: "shared" });
    const linked = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "linked");
    symlinkSync(valid, linked, process.platform === "win32" ? "junction" : "dir");
    const empty = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "empty");
    mkdirSync(empty);
    writeLogin(join(account.home, "outside", ".claude.json"), { accountUuid: "outside" });
    writeLogin(join(account.home, ".claude", ".claude.json"), { accountUuid: "own-code" });
    const invalidProfile = join(account.home, ".flywheel", "auth", "profiles", "   ", LOGIN_ACCOUNTS_DIRECTORY, "a");
    writeLogin(join(invalidProfile, ".claude.json"), { accountUuid: "invalid-profile" });
    for (const [index, configDir] of [join(account.home, ".claude"), "relative", linked, empty, join(account.home, "outside"), `${valid}-missing`, invalidProfile].entries()) {
      writeFileSync(join(root, `${index}.reference.json`), JSON.stringify({ version: 1, configDir }));
    }
    writeFileSync(join(root, "future.reference.json"), JSON.stringify({ version: 2, configDir: valid }));
    const warning = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn").mockImplementation(() => {});
    try {
      expect(profileClaudeAccounts(authDir, account.home)).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(8);
      expect(profileClaudeAccounts(authDir, account.home)).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(8);
    } finally {
      warning.mockRestore();
    }
    expect(readdirSync(root)).toHaveLength(8);
  });

  test("removing a profile removes its references without logging out the shared login", async () => {
    const { account, authDir, otherAuthDir } = place();
    const configDir = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "a");
    writeLogin(join(configDir, ".claude.json"), { accountUuid: "shared" });
    mkdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY), { recursive: true });
    const reference = join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "shared.reference.json");
    writeFileSync(reference, JSON.stringify({ version: 1, configDir }));
    const cli = fakeCli(account, () => ({ oauthAccount: {} }));
    await logoutProfileClaudeAccounts(profile(authDir, account), { launcher: cli.launcher });
    expect(cli.runs).toEqual([]);
    expect(existsSync(reference)).toBe(false);
    expect(cliLoginAccount(configDir)?.accountId).toBe("shared");
  });

  test("finds each login of the profile once, by the account in the CLI's token-free account object, and never the person's own `claude` login", () => {
    const { account, authDir } = place();
    const logins = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
    writeLogin(join(logins, "b", ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com", seatTier: "enterprise_usage_based", billingType: "aws_marketplace" });
    writeLogin(join(logins, "a", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com", organizationUuid: "org" });
    writeLogin(join(logins, "aa", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    writeLogin(join(logins, "c", ".claude.json"), { accountUuid: "uuid-no-email" });
    mkdirSync(join(logins, "d"));
    writeFileSync(join(logins, "d", ".claude.json"), "{ not json");
    writeLogin(join(logins, "e", ".claude.json"), { emailAddress: "no-account@example.com" });
    writeLogin(join(account.home, "linked", ".claude.json"), { accountUuid: "uuid-linked", emailAddress: "linked@example.com" });
    symlinkSync(join(account.home, "linked"), join(logins, "f"));

    expect(profileClaudeAccounts(authDir)).toEqual([
      { accountId: "uuid-person", identity: "person@example.com", configDir: join(logins, "a") },
      { accountId: "uuid-work", identity: "work@example.com", configDir: join(logins, "b"), billing: "metered" },
      { accountId: "uuid-no-email", identity: "uuid-no-email", configDir: join(logins, "c") },
    ]);
  });

  test("only a usage-based login's reports leave out its extra usage", () => {
    const { account } = place();
    const reports = (billingType: string | undefined) => {
      const configDir = join(account.home, `billing-${billingType ?? "none"}`);
      writeLogin(join(configDir, ".claude.json"), { accountUuid: "uuid-person", ...(billingType === undefined ? {} : { billingType }) });
      return cliLogin(configDir)?.reportsExtraUsage;
    };

    expect([reports("usage_based"), reports("stripe_subscription"), reports(undefined)]).toEqual([false, true, true]);
  });

  test("a login names the account email that the CLI adds as its session reminder, and a login without one names none", () => {
    const { account } = place();
    const email = (fields: { readonly emailAddress?: string }) => {
      const configDir = join(account.home, `email-${fields.emailAddress ?? "none"}`);
      writeLogin(join(configDir, ".claude.json"), { accountUuid: "uuid-person", ...fields });
      return cliLogin(configDir)?.email;
    };

    expect([email({ emailAddress: "person@example.com" }), email({ emailAddress: "" }), email({})]).toEqual(["person@example.com", undefined, undefined]);
  });

  test("a new profile has no account though the person's own `claude` is logged in, and a login of one profile is no account of another", () => {
    const { account, authDir, otherAuthDir } = place();
    writeLogin(join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "a", ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com" });

    expect(profileClaudeAccounts(authDir)).toEqual([]);
    expect(cliLoginAccount(join(account.home, ".claude"))).toBeUndefined();
    expect(profileClaudeAccounts(otherAuthDir).map(({ accountId }) => accountId)).toEqual(["uuid-work"]);
  });

  test("logs in to a new directory of the profile though the person's own `claude` is logged in: the URL reaches the person and the pasted code reaches the CLI", async () => {
    const { account, authDir } = place();
    const before = ownClaudeConfig(account);
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
    const { loginPorts, urls } = ports(cli.launcher);

    const login = await loginClaudeAccount(profile(authDir, account), loginPorts);

    const configDirs = readdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY)).map((name) => join(authDir, LOGIN_ACCOUNTS_DIRECTORY, name));
    const { configDir, ...found } = login;
    expect(configDirs).toEqual([configDir]);
    expect(found).toEqual({ accountId: "uuid-person", identity: "person@example.com" });
    expect(cli.runs.map(({ command }) => command)).toEqual([[CLI, "auth", "login", "--claudeai"]]);
    // The CLI names its keychain item after CLAUDE_CONFIG_DIR, so this login keeps an item of its own. A login sends no
    // nonessential traffic, which would write account caches into the login's settings.
    expect(cli.runs[0]?.env).toMatchObject({ HOME: join(login.configDir, "home"), USER: "tester", CLAUDE_CONFIG_DIR: login.configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(cli.runs[0]?.env).not.toHaveProperty("CLAUDE_SECURESTORAGE_CONFIG_DIR");
    expect(urls).toEqual([AUTHORIZE_URL]);
    expect(cli.pasted).toEqual([`pasted-code#${STATE}`]);
    expect(ownClaudeConfig(account)).toBe(before);
    expect(profileClaudeAccounts(authDir)).toEqual([login]);
  });

  test("a login that a client off this machine started opens no browser here, and a terminal login lets the CLI open one", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-phone", emailAddress: "phone@example.com" } }));
    const { loginPorts, urls } = ports(cli.launcher);
    const { openBrowser: _terminalBrowser, ...remotePorts } = loginPorts;

    await loginClaudeAccount(profile(authDir, account), remotePorts);
    await loginClaudeAccount(profile(authDir, account), loginPorts, cliLoginAccount(cli.runs[0]?.env.CLAUDE_CONFIG_DIR ?? ""));

    // The CLI runs BROWSER with its URL, so `true` opens nothing; the client that started the login opens the URL.
    expect(cli.runs.map(({ env }) => env.BROWSER)).toEqual(["true", undefined]);
    expect(urls).toEqual([AUTHORIZE_URL, AUTHORIZE_URL]);
  });

  test("adds a second account in a new directory of the profile, and logs in again in an account's own directory", async () => {
    const { account, authDir } = place();
    writeLogin(join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "first", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-work", emailAddress: "work@example.com" } }));

    const added = await loginClaudeAccount(profile(authDir, account), { ...ports(cli.launcher).loginPorts, loginHint: "work@example.com" });
    const again = await loginClaudeAccount(profile(authDir, account), ports(cli.launcher).loginPorts, added);

    expect(added.configDir.startsWith(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toBe(true);
    expect(added).toMatchObject({ accountId: "uuid-work", identity: "work@example.com" });
    expect(again).toEqual(added);
    expect(cli.runs.map(({ command, env }) => ({ command, configDir: env.CLAUDE_CONFIG_DIR }))).toEqual([
      { command: [CLI, "auth", "login", "--claudeai", "--email", "work@example.com"], configDir: added.configDir },
      { command: [CLI, "auth", "login", "--claudeai"], configDir: added.configDir },
    ]);
    expect(profileClaudeAccounts(authDir).map(({ accountId }) => accountId).toSorted()).toEqual(["uuid-person", "uuid-work"]);
  });

  test("one Claude account logged in to two profiles has two logins, and the logout of one leaves the other", async () => {
    const { account, authDir, otherAuthDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));

    const first = await loginClaudeAccount(profile(authDir, account), ports(cli.launcher).loginPorts);
    const second = await loginClaudeAccount(profile(otherAuthDir, account), ports(cli.launcher).loginPorts);
    await logoutClaudeAccount(profile(authDir, account), first.accountId, { launcher: cli.launcher });

    expect(first.accountId).toBe(second.accountId);
    expect(second.configDir.startsWith(join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY))).toBe(true);
    expect(profileClaudeAccounts(authDir)).toEqual([]);
    expect(profileClaudeAccounts(otherAuthDir)).toEqual([second]);
    expect(cli.runs.map(({ command, env }) => ({ command: command.slice(1, 3), configDir: env.CLAUDE_CONFIG_DIR }))).toEqual([
      { command: ["auth", "login"], configDir: first.configDir },
      { command: ["auth", "login"], configDir: second.configDir },
      { command: ["auth", "logout"], configDir: first.configDir },
    ]);
  });

  test("a failed login names the CLI's reason and leaves no directory behind", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ failure: "Request failed with status code 400" }));

    await expect(loginClaudeAccount(profile(authDir, account), ports(cli.launcher).loginPorts)).rejects.toThrow("The Claude CLI login did not complete: Login failed: Request failed with status code 400");

    expect(readdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toEqual([]);
  });

  test("the person pastes only the code that the page shows, and the CLI receives it with the state of the URL it printed", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));

    const login = await loginClaudeAccount(profile(authDir, account), ports(cli.launcher, "pasted-code").loginPorts);

    expect(cli.pasted).toEqual([`pasted-code#${STATE}`]);
    expect(login).toMatchObject({ accountId: "uuid-person" });
  });

  test("a pasted code of another login ends the CLI, says so, and leaves no directory behind", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person" } }));

    await expect(loginClaudeAccount(profile(authDir, account), ports(cli.launcher, "pasted-code#other-state").loginPorts))
      .rejects.toThrow("The pasted code is from another login");

    expect(cli.pasted).toEqual([]);
    expect(cli.terminated()).toBe(1);
    expect(readdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toEqual([]);
  });

  test("a code that the CLI rejects ends the CLI and the login with the CLI's reason, and leaves no directory behind", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person" } }));

    await expect(loginClaudeAccount(profile(authDir, account), ports(cli.launcher, " ").loginPorts))
      .rejects.toThrow("The Claude CLI did not accept the pasted code: Invalid code. Please make sure the full code was copied.");

    expect(cli.pasted).toEqual([`#${STATE}`]);
    expect(cli.terminated()).toBe(1);
    expect(readdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toEqual([]);
  });

  test("adding an account that another directory of the profile already holds logs the new directory out and says the account is there", async () => {
    const { account, authDir } = place();
    writeLogin(join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "first", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));

    await expect(loginClaudeAccount(profile(authDir, account), ports(cli.launcher).loginPorts)).rejects.toThrow("The Claude account person@example.com is already added");

    const addedDir = cli.runs[0]?.env.CLAUDE_CONFIG_DIR;
    expect(addedDir?.startsWith(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toBe(true);
    expect(cli.runs.map(({ command, env }) => ({ command: command.slice(1, 3), configDir: env.CLAUDE_CONFIG_DIR }))).toEqual([
      { command: ["auth", "login"], configDir: addedDir },
      { command: ["auth", "logout"], configDir: addedDir },
    ]);
    expect(readdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toEqual(["first"]);
  });

  test("a login that completes with no account logs the new directory out before it removes the directory", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { emailAddress: "work@example.com" } }));

    await expect(loginClaudeAccount(profile(authDir, account), ports(cli.launcher).loginPorts)).rejects.toThrow("holds no account");

    expect(cli.runs.map(({ command }) => command.slice(1, 3))).toEqual([["auth", "login"], ["auth", "logout"]]);
    expect(readdirSync(join(authDir, LOGIN_ACCOUNTS_DIRECTORY))).toEqual([]);
  });

  test("a cancelled login ends the CLI and reports the cancellation", async () => {
    const { account, authDir } = place();
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-person" } }));
    const controller = new AbortController();
    const loginPorts: ExternalLoginPorts = {
      launcher: cli.launcher,
      signal: controller.signal,
      openBrowser: async () => true,
      onAuthorizeUrl: () => controller.abort(),
      onManualCodeInput: () => new Promise<string>(() => {}),
    };

    await expect(loginClaudeAccount(profile(authDir, account), loginPorts)).rejects.toThrow("Login cancelled");

    expect(cli.terminated()).toBe(1);
  });

  test("Disconnect runs the CLI's own logout on every directory of the profile that holds the account, removes the account's references, forgets each ended login, and leaves other accounts and profiles", async () => {
    const { account, authDir, otherAuthDir } = place();
    const before = ownClaudeConfig(account);
    const logins = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
    writeLogin(join(logins, "a", ".claude.json"), { accountUuid: "uuid-person" });
    writeLogin(join(logins, "b", ".claude.json"), { accountUuid: "uuid-person" });
    writeLogin(join(logins, "c", ".claude.json"), { accountUuid: "uuid-work" });
    const shared = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "x");
    writeLogin(join(shared, ".claude.json"), { accountUuid: "uuid-person" });
    writeFileSync(join(logins, "shared.reference.json"), JSON.stringify({ version: 1, configDir: shared }));
    const cli = fakeCli(account, () => ({ failure: "unused" }));
    const forgotten: LoginKey[] = [];

    await logoutClaudeAccount(profile(authDir, account, forgotten), "uuid-person", { launcher: cli.launcher });

    expect(cli.runs.map(({ command, env }) => ({ command, configDir: env.CLAUDE_CONFIG_DIR }))).toEqual([
      { command: [CLI, "auth", "logout"], configDir: join(logins, "a") },
      { command: [CLI, "auth", "logout"], configDir: join(logins, "b") },
    ]);
    expect(readdirSync(logins)).toEqual(["c"]);
    expect(forgotten).toEqual([
      { configDir: join(logins, "a"), accountId: "uuid-person" }, { configDir: join(logins, "b"), accountId: "uuid-person" }, { configDir: shared, accountId: "uuid-person" },
    ]);
    expect(profileClaudeAccounts(otherAuthDir).map(({ accountId }) => accountId)).toEqual(["uuid-person"]);
    expect(ownClaudeConfig(account)).toBe(before);
  });

  test("logging in again as an account that other locations of the profile hold keeps the location just logged in and retires the others, once each", async () => {
    const { account, authDir, otherAuthDir } = place();
    const logins = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
    writeLogin(join(logins, "a", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    writeLogin(join(logins, "b", ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com" });
    const shared = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "x");
    writeLogin(join(shared, ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com" });
    const reference = join(logins, "work.reference.json");
    writeFileSync(reference, JSON.stringify({ version: 1, configDir: shared }));
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-work", emailAddress: "work@example.com" } }));
    const forgotten: LoginKey[] = [];
    const previous = profileClaudeAccounts(authDir, account.home).find(({ accountId }) => accountId === "uuid-person");
    const records = spyOn(DebugLog, "record");
    try {
      const login = await loginClaudeAccount(profile(authDir, account, forgotten), ports(cli.launcher).loginPorts, previous);

      expect(login).toEqual({ accountId: "uuid-work", identity: "work@example.com", configDir: join(logins, "a") });
      expect(cli.runs.map(({ command, env }) => ({ command: command.slice(1, 3), configDir: env.CLAUDE_CONFIG_DIR }))).toEqual([
        { command: ["auth", "login"], configDir: join(logins, "a") },
        { command: ["auth", "logout"], configDir: join(logins, "b") },
      ]);
      expect(readdirSync(logins)).toEqual(["a"]);
      expect(profileClaudeAccounts(authDir, account.home)).toEqual([login]);
      expect(cliLoginAccount(shared)?.accountId).toBe("uuid-work");
      expect(forgotten).toEqual([
        { configDir: join(logins, "a"), accountId: "uuid-person" }, { configDir: join(logins, "b"), accountId: "uuid-work" }, { configDir: shared, accountId: "uuid-work" },
      ]);
      expect(records.mock.calls.map(([record]) => record).filter(({ type }) => type === "provider.claude_sdk.login.retired")).toEqual([
        { type: "provider.claude_sdk.login.retired", payload: { kind: "directory", retired: "b", kept: "a", outcome: "retired" } },
        { type: "provider.claude_sdk.login.retired", payload: { kind: "reference", retired: "work.reference.json", kept: "a", outcome: "retired" } },
      ]);
    } finally {
      records.mockRestore();
    }
  });

  test("a login again whose duplicates do not log out tries every duplicate, then fails with what the person must do and keeps the failed duplicates' files", async () => {
    const { account, authDir, otherAuthDir } = place();
    const logins = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
    // A duplicate sorts first, so it would serve the account while it stays.
    writeLogin(join(logins, "a", ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com" });
    writeLogin(join(logins, "b", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    writeLogin(join(logins, "c", ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com" });
    const shared = join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "x");
    writeLogin(join(shared, ".claude.json"), { accountUuid: "uuid-work", emailAddress: "work@example.com" });
    writeFileSync(join(logins, "work.reference.json"), JSON.stringify({ version: 1, configDir: shared }));
    const cli = fakeCli(account, () => ({ oauthAccount: { accountUuid: "uuid-work", emailAddress: "work@example.com" } }), 1);
    const forgotten: LoginKey[] = [];
    const previous = profileClaudeAccounts(authDir, account.home).find(({ accountId }) => accountId === "uuid-person");
    const records = spyOn(DebugLog, "record");
    try {
      const login = loginClaudeAccount(profile(authDir, account, forgotten), ports(cli.launcher).loginPorts, previous);

      await expect(login).rejects.toThrow("The Claude CLI logged in to work@example.com, but 2 other logins of the account in this profile did not end (The Claude CLI logout did not complete; The Claude CLI logout did not complete). Log in to the account again to retry.");
      expect(readdirSync(logins).toSorted()).toEqual(["a", "b", "c"]);
      expect(cliLoginAccount(join(logins, "a"))?.accountId).toBe("uuid-work");
      expect(cliLoginAccount(join(logins, "c"))?.accountId).toBe("uuid-work");
      expect(cliLoginAccount(shared)?.accountId).toBe("uuid-work");
      expect(forgotten).toEqual([{ configDir: join(logins, "b"), accountId: "uuid-person" }, { configDir: shared, accountId: "uuid-work" }]);
      expect(records.mock.calls.map(([record]) => record).filter(({ type }) => type === "provider.claude_sdk.login.retired")).toEqual([
        { type: "provider.claude_sdk.login.retired", payload: { kind: "directory", retired: "a", kept: "b", outcome: "failed" } },
        { type: "provider.claude_sdk.login.retired", payload: { kind: "directory", retired: "c", kept: "b", outcome: "failed" } },
        { type: "provider.claude_sdk.login.retired", payload: { kind: "reference", retired: "work.reference.json", kept: "b", outcome: "retired" } },
      ]);
    } finally {
      records.mockRestore();
    }
  });

  test("a profile's removal logs out every login of the profile, a hidden one too, and no login of another profile", async () => {
    const { account, authDir, otherAuthDir } = place();
    const before = ownClaudeConfig(account);
    const logins = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
    writeLogin(join(logins, "a", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    writeLogin(join(logins, "b", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    mkdirSync(join(logins, "c"));
    writeLogin(join(otherAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "a", ".claude.json"), { accountUuid: "uuid-person", emailAddress: "person@example.com" });
    const cli = fakeCli(account, () => ({ failure: "unused" }));
    const forgotten: LoginKey[] = [];

    await logoutProfileClaudeAccounts(profile(authDir, account, forgotten), { launcher: cli.launcher });

    // The file system decides the order of the logins: Linux lists a directory in hash order.
    const logouts = cli.runs.map(({ command, env }) => ({ command: command.slice(1), configDir: env.CLAUDE_CONFIG_DIR }));
    expect(logouts.toSorted((left, right) => String(left.configDir).localeCompare(String(right.configDir)))).toEqual([
      { command: ["auth", "logout"], configDir: join(logins, "a") },
      { command: ["auth", "logout"], configDir: join(logins, "b") },
    ]);
    expect(forgotten.map(({ configDir }) => configDir).toSorted()).toEqual([join(logins, "a"), join(logins, "b")]);
    expect(readdirSync(logins)).toEqual(["c"]);
    expect(profileClaudeAccounts(otherAuthDir).map(({ accountId }) => accountId)).toEqual(["uuid-person"]);
    expect(ownClaudeConfig(account)).toBe(before);
  });

  test("a failed logout keeps the account's directory", async () => {
    const { account, authDir } = place();
    const addedDir = join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "added");
    writeLogin(join(addedDir, ".claude.json"), { accountUuid: "uuid-work" });
    const cli = fakeCli(account, () => ({ failure: "unused" }), 1);

    await expect(logoutClaudeAccount(profile(authDir, account), "uuid-work", { launcher: cli.launcher })).rejects.toThrow("The Claude CLI logout did not complete");

    expect(existsSync(addedDir)).toBe(true);
  });
});
