import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { DebugLog } from "../../../infra/debug-log.js";
import { errorMessage } from "../../../infra/error-message.js";
import { ContainedDirectory } from "../../../infra/descriptor-directory.js";
import { Log } from "../../../infra/log.js";
import { osAccount } from "../../../infra/os-account.js";
import type { ExternalAccount, ExternalLoginPorts } from "../../../infra/llm/access-provider.js";
import { runOwnedCommand } from "../../../infra/owned-command.js";
import { isAuthProfileName } from "../../../infra/paths.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import { cliLoginEnvironment, type EngineHost } from "./cli-environment.js";
import type { LoginKey } from "./login-observations.js";
import { globalConfigPath, LOGIN_ACCOUNTS_DIRECTORY } from "./names.js";

const REFERENCE_SUFFIX = ".reference.json";
const log = Log.create({ service: "provider-claude-agent-sdk" });
const warnedReferences = new Set<string>();
/** A logout ends well inside this bound; a CLI that does not is ended. */
const LOGOUT_TIMEOUT_MS = 30_000;
/** The longest CLI failure text that an error carries. */
const MAX_REASON_CHARS = 300;

/** Whether Claude extra usage can bill an account, as the CLI last recorded it. */
type CliExtraUsage = "enabled" | "disabled" | "unknown";

interface ClaudeAccount extends ExternalAccount {
  /** Disconnect removes this profile's token-free reference, not the shared login. */
  readonly referencePath?: string;
}

/** The reference file of an account that `profileClaudeAccounts` read from a shared login, which the generic account
 *  type carries through the auth layer unchanged. */
function referencePathOf(account: Pick<ExternalAccount, "configDir"> | undefined): string | undefined {
  return account !== undefined && "referencePath" in account && typeof account.referencePath === "string" ? account.referencePath : undefined;
}

/** The token-free account details of one login. */
export interface CliLogin {
  readonly account: ExternalAccount;
  readonly extraUsage: CliExtraUsage;
  /** Whether the CLI's usage reports state extra usage. The CLI omits that state from the reports of an account whose
   *  `billingType` is `usage_based` (CLI 2.1.295), so no report of such an account shows which usage served a response. */
  readonly reportsExtraUsage: boolean;
  /** The account's email, which the CLI of a Claude login adds to the conversation as its `session_context`
   *  reminder. */
  readonly email?: string;
  /** Whether the engine may keep the login's token in Windows Credential Manager. Engine 2.1.296 uses that store on
   *  Windows only when the feature flag that it cached in this config (`tengu_windows_credman`) is on, or when
   *  `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN` is 1, which no Flywheel engine receives. Otherwise it keeps the token in
   *  the credentials file. */
  readonly windowsCredentialManager: boolean;
}

interface ReadLogin {
  readonly mtimeMs: number;
  readonly size: number;
  readonly login: CliLogin | undefined;
}

/** The last read of each global config. The file also holds the CLI's project history, which can be megabytes, so
 *  a file whose size and time are unchanged is not parsed again. */
const readLogins = new Map<string, ReadLogin>();

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether extra usage can bill the account. After each response the CLI records the service's reason that extra
 * usage is off as `cachedExtraUsageDisabledReason`, and null when no reason keeps it off (CLI 2.1.295). A reason
 * that the service could not decide states nothing. Before its first response the CLI has only the account profile
 * that its login read, which states `hasExtraUsageEnabled`.
 */
function extraUsage(config: { readonly [key: string]: unknown }, oauthAccount: { readonly [key: string]: unknown }): CliExtraUsage {
  const reason = config.cachedExtraUsageDisabledReason;
  if (reason === null) return "enabled";
  if (typeof reason === "string") return reason === "fetch_error" || reason === "unknown" ? "unknown" : "disabled";
  const enabled = oauthAccount.hasExtraUsageEnabled;
  return enabled === true ? "enabled" : enabled === false ? "disabled" : "unknown";
}

function parseLogin(text: string, configDir: string): CliLogin | undefined {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(config) || !isRecord(config.oauthAccount)) return undefined;
  const { accountUuid, emailAddress, planDisplayName } = config.oauthAccount;
  if (typeof accountUuid !== "string" || accountUuid.length === 0) return undefined;
  const email = typeof emailAddress === "string" && emailAddress.length > 0 ? emailAddress : undefined;
  return {
    ...(email === undefined ? {} : { email }),
    account: {
      accountId: accountUuid, identity: email ?? accountUuid, configDir,
      ...(typeof planDisplayName === "string" && planDisplayName.length > 0 ? { plan: planDisplayName } : {}),
      ...(config.oauthAccount.seatTier === "enterprise_usage_based" ? { billing: "metered" as const } : {}),
    },
    extraUsage: extraUsage(config, config.oauthAccount),
    reportsExtraUsage: config.oauthAccount.billingType !== "usage_based",
    windowsCredentialManager: isRecord(config.cachedGrowthBookFeatures) && config.cachedGrowthBookFeatures.tengu_windows_credman === true,
  };
}

/**
 * The login that the CLI holds in `configDir`, or undefined when it holds none. It reads only the `oauthAccount`
 * object, whose `planDisplayName` some CLI releases record after a login (CLI 2.1.295) and whose `billingType` names how the account pays, and the extra-usage state of the CLI's global config, which name the account and hold no token. The token
 * stays in the CLI's own store, which Flywheel never reads. A missing, unreadable, or malformed file holds no login.
 */
export function cliLogin(configDir: string): CliLogin | undefined {
  const path = globalConfigPath(configDir);
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(path));
  } catch {
    return undefined;
  }
  const read = readLogins.get(path);
  if (read?.size === size && read.mtimeMs === mtimeMs) return read.login;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const login = parseLogin(text, configDir);
  readLogins.set(path, { size, mtimeMs, login });
  return login;
}

/** The account that the CLI's login in `configDir` holds (`cliLogin`). */
export function cliLoginAccount(configDir: string): ExternalAccount | undefined {
  return cliLogin(configDir)?.account;
}

/** Own login folders and references to logins in the same OS account's normal Flywheel home. References never follow a link, including a Windows junction. */
function profileLoginLocations(authDir: string, accountHome?: string): readonly Pick<ClaudeAccount, "configDir" | "referencePath">[] {
  const root = join(authDir, LOGIN_ACCOUNTS_DIRECTORY);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // Normal profiles retain their directory-only startup cost.
  if (!entries.some(({ name }) => name.endsWith(REFERENCE_SUFFIX))) {
    return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort().map((name) => ({ configDir: join(root, name) }));
  }
  const names = entries.map(({ name }) => name).sort();
  const directory = ContainedDirectory.openExisting(authDir, [LOGIN_ACCOUNTS_DIRECTORY], { noFollowBase: true });
  if (directory === undefined) return [];
  try {
    const own = new Set(directory.directoryEntryNames());
    return names.flatMap((name) => {
      if (own.has(name)) return [{ configDir: join(root, name) }];
      if (!name.endsWith(REFERENCE_SUFFIX)) return [];
      const referencePath = join(root, name);
      try {
        const text = directory.readFile(name, 16 * 1024);
        const reference: unknown = text === undefined ? undefined : JSON.parse(text.toString("utf8"));
        if (!isRecord(reference) || reference.version !== 1 || typeof reference.configDir !== "string" || !isAbsolute(reference.configDir)) throw new Error("invalid reference");
        const home = accountHome ?? osAccount().home;
        const profiles = join(home, ".flywheel", "auth", "profiles");
        const parts = relative(profiles, reference.configDir).split(sep);
        const [profile, logins] = parts;
        if (parts.length !== 3 || profile === undefined || !isAuthProfileName(profile) || logins !== LOGIN_ACCOUNTS_DIRECTORY) throw new Error("reference outside profile logins");
        const target = ContainedDirectory.openExisting(home, [".flywheel", "auth", "profiles", ...parts], { noFollowBase: true });
        if (target === undefined) throw new Error("missing reference target");
        try {
          // Keychain item names include this path. Preserve the account home's spelling after the no-follow walk.
          const configDir = join(profiles, ...parts);
          const config = target.readFile(".claude.json", 16 * 1024 * 1024);
          if (config === undefined || parseLogin(config.toString("utf8"), configDir) === undefined) throw new Error("reference target has no login");
          return [{ configDir, referencePath }];
        } finally {
          target.close();
        }
      } catch {
        if (!warnedReferences.has(referencePath)) {
          warnedReferences.add(referencePath);
          log.warn("a Claude login reference is invalid or unavailable; it is ignored and its file is kept", { referencePath });
        }
        return [];
      }
    });
  } finally {
    directory.close();
  }
}

/** The profile's own login folders and validated shared login targets, in name order. Reads no token. */
export function loginDirectories(authDir: string, accountHome?: string): readonly string[] {
  return profileLoginLocations(authDir, accountHome).map(({ configDir }) => configDir);
}

/** Writes references to every Claude login of `sourceProfile` into `destinationProfile`. Reads no token and leaves source logins unchanged. Rejects if a destination reference cannot be created.
 *
 *  @public
 *  `scripts/uat/harness.ts` calls it to give an isolated UAT home the subscription of the profile it clones. Knip does
 *  not trace scripts into the production project, so this export is not dead. */
export function writeClaudeLoginReferences(sourceProfile: string, destinationProfile: string): void {
  for (const configDir of loginDirectories(sourceProfile)) {
    if (cliLoginAccount(configDir) === undefined) continue;
    const references = ContainedDirectory.open(destinationProfile, [LOGIN_ACCOUNTS_DIRECTORY], { privateDirectories: true, noFollowBase: true });
    try {
      if (!references.createExclusive(`${crypto.randomUUID()}${REFERENCE_SUFFIX}`, JSON.stringify({ version: 1, configDir }))) throw new Error("Claude login reference already exists");
    } finally {
      references.close();
    }
  }
}

/** The Claude accounts of the auth profile in `authDir`, each once, in the order of `loginDirectories`. When two
 *  directories hold one account, the first one serves it. A new profile has none until the person logs in. */
export function profileClaudeAccounts(authDir: string, accountHome?: string): readonly ClaudeAccount[] {
  const seen = new Set<string>();
  return profileLoginLocations(authDir, accountHome).flatMap(({ configDir, referencePath }) => {
    const found = cliLoginAccount(configDir);
    if (found === undefined || seen.has(found.accountId)) return [];
    seen.add(found.accountId);
    return [referencePath === undefined ? found : { ...found, referencePath }];
  });
}

/** The last line that the CLI wrote to stderr, which names why its command failed. It holds no token. */
function failureReason(stderr: string): string {
  const line = stderr.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0).at(-1);
  return line === undefined ? "" : `: ${line.slice(0, MAX_REASON_CHARS)}`;
}

/** The URL that the CLI prints for a person whose browser did not open: "If the browser didn't open, visit: <url>".
 *  That page shows the code that the person pastes. */
const VISIT_URL = /visit:\s*(https:\/\/\S+)/u;
// oxlint-disable-next-line no-control-regex -- boundary: the CLI's output can carry terminal escape sequences
const TERMINAL_ESCAPES = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu;
/** What the CLI writes to stderr for a pasted line that it cannot read as `code#state` (CLI 2.1.295). The CLI then
 *  waits for another line, which a login that asks the person once never sends. */
const REJECTED_CODE = /^Invalid code\b/u;

/** Calls `onLine` with each line of `stream`, without terminal escape sequences, and returns the stream's last text. */
async function readText(stream: ReadableStream<Uint8Array> | undefined, onLine?: (line: string) => void): Promise<string> {
  if (stream === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  let pending = "";
  for await (const chunk of stream) {
    const decoded = decoder.decode(chunk, { stream: true });
    text = (text + decoded).slice(-4 * MAX_REASON_CHARS);
    pending += decoded;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine?.(line.replaceAll(TERMINAL_ESCAPES, ""));
  }
  if (pending.length > 0) onLine?.(pending.replaceAll(TERMINAL_ESCAPES, ""));
  return text;
}

/**
 * The line that the CLI reads for what the person pasted. The CLI reads `code#state` (CLI 2.1.295), which is the text
 * that the code page shows. The state is also in the URL that the CLI printed, so a person who pastes only the code
 * gets the state of that URL added. A pasted state that differs from the URL's is from another login, whose code
 * this CLI can never exchange: only the CLI that printed a URL holds the PKCE verifier of that login. That refusal
 * is the returned error.
 */
function codeLine(pasted: string, url: string): string | Error {
  const text = pasted.trim();
  const state = URL.parse(url)?.searchParams.get("state") ?? undefined;
  if (state === undefined) return text;
  const separator = text.indexOf("#");
  if (separator < 0) return `${text}#${state}`;
  if (text.slice(separator + 1) !== state) return new Error("The pasted code is from another login. Open the URL of this login, then paste the code that its page shows.");
  return text;
}

/** What the CLI runs as `BROWSER` when the login must open no page on this machine. The CLI runs `BROWSER <url>`
 * in place of its platform opener (CLI 2.1.296), and `true` does nothing. The CLI's own background sessions use the
 * same value. */
const NO_BROWSER = { BROWSER: "true" } as const;

/**
 * Runs `claude auth login` for one config directory, through the launcher. With `ports.openBrowser`, the person is at
 * this machine, and the CLI opens the browser and receives the callback itself. Without it, the login came from a
 * client that can be on another machine, such as the phone, so the CLI opens no page here and that client opens the
 * printed URL. The URL it prints goes to `onAuthorizeUrl`, and a code that the person pastes goes to the
 * CLI's standard input as `codeLine` writes it: the code is useless without the PKCE verifier that only this CLI
 * holds. Flywheel never sees the token. The person is asked once, so a pasted code that Flywheel or the CLI refuses
 * ends the CLI with the reason, and the CLI never waits for a line that does not come. Resolves when the CLI exits
 * after a login, and rejects when it fails, refuses the code, or the signal ends it.
 */
async function runCliLogin(configDir: string, host: EngineHost, ports: ExternalLoginPorts): Promise<void> {
  const env = { ...cliLoginEnvironment({ ...host, configDir }), ...(ports.openBrowser === undefined ? NO_BROWSER : {}) };
  const command = [host.enginePath, "auth", "login", "--claudeai", ...(ports.loginHint === undefined ? [] : ["--email", ports.loginHint])];
  ports.signal?.throwIfAborted();
  // The private temporary directory holds no project, so the engine reads no project's `claude` settings.
  const owned = await ports.launcher.spawnOwned(command, { env, cwd: host.temporaryDirectory });
  const end = (): void => { void owned.terminate(); };
  let refusal: string | undefined;
  const refuse = (reason: string): void => {
    refusal ??= reason;
    end();
  };
  ports.signal?.addEventListener("abort", end, { once: true });
  let reported = false;
  const reportUrl = (line: string): void => {
    const url = VISIT_URL.exec(line)?.[1];
    if (url === undefined || reported) return;
    reported = true;
    ports.onAuthorizeUrl?.({ url });
    // The pasted code goes to the CLI and nowhere else: it is never logged or kept.
    void ports.onManualCodeInput?.().then((pasted) => {
      const answer = codeLine(pasted, url);
      if (answer instanceof Error) {
        refuse(answer.message);
        return;
      }
      owned.stdin?.write(`${answer}\n`);
      void owned.stdin?.flush();
    }, () => {});
  };
  const reportRejection = (line: string): void => {
    const text = line.trim();
    if (REJECTED_CODE.test(text)) refuse(`The Claude CLI did not accept the pasted code: ${text.slice(0, MAX_REASON_CHARS)}`);
  };
  try {
    const [, stderr, exit] = await Promise.all([readText(owned.stdout, reportUrl), readText(owned.stderr, reportRejection), owned.exited]);
    if (ports.signal?.aborted) throw new Error("Login cancelled");
    if (refusal !== undefined) throw new Error(refusal);
    if (exit.code !== 0) throw new Error(`The Claude CLI login did not complete${failureReason(stderr)}`);
  } finally {
    ports.signal?.removeEventListener("abort", end);
    void owned.stdin?.end();
  }
}

/** One auth profile's Claude logins, and what a change of them uses. */
export interface ClaudeProfile {
  readonly authDir: string;
  readonly host: EngineHost;
  /** The home whose Flywheel profiles a reference may name; this process's OS account's home when absent. */
  readonly accountHome?: string;
  /** Forgets what this process observed about a login that ended (`LoginObservations.forget`). */
  readonly forget: (login: LoginKey) => void;
}

interface LogoutPorts {
  readonly launcher: LauncherScope;
  readonly signal?: AbortSignal;
}

/** Where the profile holds one login: its own directory, or a reference to a login of another profile. */
type LoginLocation = Pick<ClaudeAccount, "configDir" | "referencePath">;

/** The entry of the profile that is the location: a reference's file, else the login's own directory. */
function locationPath(location: LoginLocation): string {
  return location.referencePath ?? location.configDir;
}

/** The locations of the profile whose login holds `accountId`, other than `except`. */
function locationsOf(profile: ClaudeProfile, accountId: string, except?: LoginLocation): readonly LoginLocation[] {
  const excluded = except === undefined ? undefined : locationPath(except);
  return profileLoginLocations(profile.authDir, profile.accountHome)
    .filter((location) => locationPath(location) !== excluded && cliLoginAccount(location.configDir)?.accountId === accountId);
}

/** Throws what the ends of several locations left: the one failure itself, or every failure together. */
function throwFailures(failures: readonly unknown[], summary: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} ${summary}`);
}

/**
 * Logs in with the CLI's own command and returns the account that the CLI then holds. `previous` logs in again in
 * that account's location. Without it, the login uses a new directory of this profile, so the login belongs to
 * this profile alone, even when the person's own `claude` installation or another profile holds the same account.
 *
 * One account has one location per profile. A new directory that the login does not leave as a new account is
 * removed: a failed login leaves nothing in it, and a completed login that holds no account, or an account that
 * another location of the profile already holds, logs out first. Without that logout the CLI would keep a stored
 * login that Flywheel never shows and can never end. A login again that leaves `previous`'s location with an account
 * that another location of the profile holds keeps the location that the person just logged in, and retires the
 * other one as Disconnect would end it. It rejects, after it tried every such location, when one of them did not end.
 * A login again that leaves `previous`'s location with another account, or with none, forgets `previous`'s login
 * there (`ClaudeProfile.forget`).
 */
export async function loginClaudeAccount(profile: ClaudeProfile, ports: ExternalLoginPorts, previous?: ExternalAccount): Promise<ClaudeAccount> {
  const { authDir, host } = profile;
  const referencePath = referencePathOf(previous);
  const configDir = previous?.configDir ?? join(authDir, LOGIN_ACCOUNTS_DIRECTORY, crypto.randomUUID());
  const created = previous === undefined;
  if (created) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    await runCliLogin(configDir, host, ports);
  } catch (error) {
    if (created) rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
  const account = cliLoginAccount(configDir);
  // The location no longer holds `previous`'s account, so that login ended here: its question and waiting runs end.
  if (previous !== undefined && account?.accountId !== previous.accountId) profile.forget({ configDir, accountId: previous.accountId });
  const location = { configDir, ...(referencePath === undefined ? {} : { referencePath }) };
  const duplicates = account === undefined ? [] : locationsOf(profile, account.accountId, location);
  if (account === undefined || (created && duplicates.length > 0)) {
    if (created) await endLocation({ configDir }, profile, ports);
    throw new Error(account === undefined ? "The Claude CLI completed its login but holds no account" : `The Claude account ${account.identity} is already added`);
  }
  // Routing serves an account from its first location in name order, so the login completes only when it is the
  // account's one location. A duplicate that does not end keeps its files for the person's next attempt.
  const failures: unknown[] = [];
  for (const duplicate of duplicates) {
    const outcome = await endLocation(duplicate, profile, ports).then(() => "retired" as const, (error: unknown) => {
      failures.push(error);
      return "failed" as const;
    });
    DebugLog.record({ type: "provider.claude_sdk.login.retired", payload: {
      kind: duplicate.referencePath === undefined ? "directory" : "reference", retired: basename(locationPath(duplicate)), kept: basename(locationPath(location)), outcome,
    } });
  }
  if (failures.length > 0) {
    const others = failures.length === 1 ? "another login of the account in this profile" : `${failures.length} other logins of the account in this profile`;
    throw new AggregateError(failures, `The Claude CLI logged in to ${account.identity}, but ${others} did not end (${failures.map(errorMessage).join("; ")}). Log in to the account again to retry.`);
  }
  return { ...account, ...location };
}

/** Ends one location: removes a shared login's reference without running the CLI, or else logs its login out with
 *  the CLI's own command and removes the login's directory, which holds nothing else that Flywheel or the person
 *  needs. Then it forgets what this process observed about the login, so no waiting request or question of this
 *  profile outlives the location. The login of the same account in another profile, or in the person's own `claude`
 *  installation, has its own directory and keychain item, so it stays. */
async function endLocation(location: LoginLocation, { host, forget }: ClaudeProfile, ports: LogoutPorts): Promise<void> {
  const { configDir, referencePath } = location;
  const account = cliLoginAccount(configDir);
  if (referencePath !== undefined) rmSync(referencePath, { force: true });
  else {
    const env = cliLoginEnvironment({ ...host, configDir });
    const result = await runOwnedCommand(ports.launcher, [host.enginePath, "auth", "logout"], { env, cwd: host.temporaryDirectory, timeoutMs: LOGOUT_TIMEOUT_MS, ...(ports.signal === undefined ? {} : { signal: ports.signal }) });
    if (result.exitCode !== 0) throw new Error(`The Claude CLI logout did not complete${failureReason(result.stderr)}`);
    rmSync(configDir, { recursive: true, force: true });
  }
  if (account !== undefined) forget({ configDir, accountId: account.accountId });
}

/** Disconnects one account from the profile: ends every location of the profile that holds `accountId`
 *  (`endLocation`). An account that no location holds is already gone. Rejects after it tried every location when
 *  one of them did not end. */
export async function logoutClaudeAccount(profile: ClaudeProfile, accountId: string, ports: LogoutPorts): Promise<void> {
  const failures: unknown[] = [];
  for (const location of locationsOf(profile, accountId)) {
    try {
      await endLocation(location, profile, ports);
    } catch (error) {
      failures.push(error);
    }
  }
  throwFailures(failures, "Claude CLI logins of the account did not end");
}

/** Ends every location of the profile (`endLocation`), one that another directory hides too, before the profile's
 *  directory goes, and removes every reference file, an invalid one too. The CLI keeps each token in its own store,
 *  such as the macOS keychain, so removing the directory alone would leave a token that nothing can show or end.
 *  Rejects after it tried every login when one of them did not end. */
export async function logoutProfileClaudeAccounts(profile: ClaudeProfile, ports: LogoutPorts): Promise<void> {
  const failures: unknown[] = [];
  for (const location of profileLoginLocations(profile.authDir, profile.accountHome)) {
    if (cliLoginAccount(location.configDir) === undefined) continue;
    try {
      await endLocation(location, profile, ports);
    } catch (error) {
      failures.push(error);
    }
  }
  const root = join(profile.authDir, LOGIN_ACCOUNTS_DIRECTORY);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && entry.name.endsWith(REFERENCE_SUFFIX)) rmSync(join(root, entry.name), { force: true });
    }
  }
  throwFailures(failures, "Claude CLI logins of the profile did not end");
}
