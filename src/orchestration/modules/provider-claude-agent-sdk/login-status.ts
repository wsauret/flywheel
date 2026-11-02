import type { ExternalAccount, ExternalLoginProblem } from "../../../infra/llm/access-provider.js";
import { errorMessage } from "../../../infra/error-message.js";
import { keychainUnlocked } from "../../../infra/macos-keychain.js";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";
import type { ModuleHealthReport } from "../../module-health.js";
import { cliAccount, observationsOf, type ClaudeAgentSdkSeams } from "./cli-launch.js";
import { cliLoginAccount, loginDirectories } from "./cli-login.js";
import { enginePath, readEngineVersion } from "./engine.js";
import { ENGINE_CANNOT_START, type LoginFailure, type RequestOutcome } from "./login-observations.js";
import { loginToken, type LoginToken, type TokenProbe } from "./login-token.js";

/** The step that repairs one failed login, as a person reads it beside the account. It names no account: the
 *  problem also becomes a project notification, whose text must hold no account subject data (ARCH-BOUNDARIES-015). */
function failureMessage(failure: LoginFailure): string {
  switch (failure) {
    case "login-rejected": return "Claude refused this account's login in this profile. Log in again.";
    case "program-exited": return "The Claude engine exited while it served a request of this account. Flywheel starts it again for the next request.";
    case "program-cannot-start": return ENGINE_CANNOT_START;
  }
}

/** The problems of the Claude logins of one auth profile, with no launch: each account whose last request in this
 *  process failed for its login, because its engine exited, or because its engine could not start. */
export function loginProblems(accounts: readonly ExternalAccount[], seams: ClaudeAgentSdkSeams): readonly ExternalLoginProblem[] {
  const observations = observationsOf(seams);
  return accounts.flatMap((account) => {
    const failure = observations.failure(account);
    return failure === undefined ? [] : [{ kind: failure, accountId: account.accountId, message: failureMessage(failure) }];
  });
}

/** Where the engine keeps a login's token, as a person reads it. */
function tokenStoreText(token: LoginToken): string {
  switch (token.kind) {
    case "present": return token.store === "file" ? "the credentials file in the login folder" : "the macOS keychain";
    case "absent": return "none";
    case "unchecked": return `not checked, because ${token.reason}`;
  }
}

/** An account's status from its token alone, when no request of this process failed for it. */
function tokenStatus(token: LoginToken): string {
  switch (token.kind) {
    case "present": return "logged in";
    case "absent": return "needs login, because no token is stored for this account. Log in again from Authentication.";
    case "unchecked": return `its token was not checked, because ${token.reason}`;
  }
}

/** How a login's last request in this process ended, as a person reads it beside the account. */
function outcomeText(outcome: RequestOutcome | undefined): string {
  switch (outcome) {
    case undefined: return "none yet";
    case "served": return "served";
    case "login-rejected": return "login refused";
    case "program-exited": return "engine exited";
    case "program-cannot-start": return "engine could not start";
  }
}

/** What a token check of this process needs (`TokenProbe`), or why it cannot run: the account database names no
 *  account for this process (`cliAccount`). */
function tokenProbe(run: OwnedCommandRunner | undefined, seams: ClaudeAgentSdkSeams): TokenProbe | string {
  try {
    return { platform: seams.platform ?? process.platform, account: cliAccount(seams), run, keychainUnlocked };
  } catch (error) {
    return errorMessage(error);
  }
}

/** What a login folder of the profile holds when it serves no account: no login, or an account that an earlier folder
 *  serves (`profileClaudeAccounts`). */
function unservedFolder(configDir: string): string {
  const held = cliLoginAccount(configDir);
  return held === undefined ? `Login folder ${configDir} holds no Claude login.` : `Login folder ${configDir} holds ${held.identity}, which an earlier login folder serves.`;
}

/**
 * The provider's section of `/doctor`: the engine that ships with Flywheel, the version it names, and each login
 * folder of the auth profile in `authDir`. A folder that serves an account shows the account's plan and status, where
 * the engine keeps its token, and how its last request in this process ended; any other folder shows what it holds.
 * An account is logged in only when the engine holds its token (`loginToken`); an account record with no token needs
 * a login and attention, because its next request fails. The version comes from `<engine> --version` through `run`,
 * which reads no login. An engine that does not answer is a broken installation, which needs attention. Nothing here
 * reads a token, a secret, or a credential file.
 */
export async function claudeLoginHealth(authDir: string, accountsOf: (authDir: string) => readonly ExternalAccount[], run: OwnedCommandRunner | undefined, seams: ClaudeAgentSdkSeams): Promise<ModuleHealthReport> {
  const accounts = accountsOf(authDir);
  const engine = seams.enginePath ?? enginePath();
  const lines: string[] = [];
  let attention = false;
  if (run === undefined) {
    lines.push(`Claude engine: ${engine}. This runtime starts no program, so the engine's version is not read.`);
  } else {
    try {
      lines.push(`Claude engine: version ${await readEngineVersion(engine, run)}, at ${engine}.`);
    } catch (error) {
      attention = true;
      lines.push(`The Claude engine at ${engine} does not run: ${errorMessage(error)}. Reinstall Flywheel, or run bun install in a source checkout.`);
    }
  }
  if (accounts.length === 0) lines.push("No Claude account is logged in to this profile. Log in from Authentication.");
  const observations = observationsOf(seams);
  const probe = tokenProbe(run, seams);
  for (const configDir of loginDirectories(authDir, seams.account?.().home)) {
    const account = accounts.find((candidate) => candidate.configDir === configDir);
    if (account === undefined) {
      lines.push(unservedFolder(configDir));
      continue;
    }
    const failure = observations.failure(account);
    const plan = account.plan === undefined ? "" : ` (${account.plan})`;
    const token = typeof probe === "string" ? { kind: "unchecked" as const, reason: probe } : await loginToken(configDir, probe);
    if (failure !== undefined || token.kind === "absent") attention = true;
    lines.push(
      `${account.identity}${plan}: ${failure === undefined ? tokenStatus(token) : failureMessage(failure)}`,
      `${account.identity} login folder: ${configDir}. Token store: ${tokenStoreText(token)}. Last request in this process: ${outcomeText(observations.outcome(account))}.`,
    );
  }
  return { attention, lines };
}
