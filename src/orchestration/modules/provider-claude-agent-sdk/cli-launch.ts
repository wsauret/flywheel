import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { RuntimeCredential } from "../../../infra/auth/auth-context.js";
import { errorMessage } from "../../../infra/error-message.js";
import { osAccount, type OsAccount } from "../../../infra/os-account.js";
import type { LauncherScope } from "../../../infra/process-supervisor.js";
import { processEngineHost, type EngineHost } from "../../../infra/claude-engine.js";
import { loginOwnerHome } from "./cli-environment.js";
import type { InPlaceGate, SelfTestConfig } from "./in-place-check.js";
import type { UsageReadings } from "./account-usage.js";
import { processLoginObservations, type LoginObservations } from "./login-observations.js";
import type { CliLoginDescription, CliUsage, HostLaunch, LaunchedHost, LaunchedQuery, QueryLaunch, QueryLauncherConfig } from "./query-launcher.js";
import type { HostRegistry } from "./agent-host/host-registry.js";

/** What a fake-host script or a test replaces. Production uses none of them. */
export interface ClaudeAgentSdkSeams {
  /** Variables the engine receives after the environment allowlist: a local base URL and a dummy key. */
  readonly cliEnvironment?: { readonly [name: string]: string };
  /** An engine executable in place of the one that ships with Flywheel, such as a wrapper that traces it. */
  readonly enginePath?: string;
  /** Builds the query launcher; tests give one that starts no process. */
  readonly createLauncher?: (config: QueryLauncherConfig) => (launch: QueryLaunch) => LaunchedQuery;
  /** Builds the launcher of shared agent hosts; tests give one that starts no process. */
  readonly createHostLauncher?: (config: QueryLauncherConfig) => (launch: HostLaunch) => LaunchedHost;
  /** The shared agent hosts, in place of this process's, so a test reads its own hosts. */
  readonly agentHosts?: HostRegistry;
  /** A short dispatcher deadline of the hosts that the client opens, in place of the default
   *  (`AgentHostConfig.dispatcherStepDeadlineMs`), so a test sees a stalled dispatcher close its host. */
  readonly dispatcherStepDeadlineMs?: number;
  /** Reads the engine's login and model lineup for the model listing; tests give one that starts no process. */
  readonly describeLogin?: (config: QueryLauncherConfig, signal: AbortSignal) => Promise<CliLoginDescription>;
  /** Reads the usage of the engine's login for the usage reader; tests give one that starts no process. */
  readonly readUsage?: (config: QueryLauncherConfig, signal: AbortSignal) => Promise<CliUsage>;
  /** The usage readings that the bridges record and the usage reader reads, in place of this process's. */
  readonly usageReadings?: UsageReadings;
  /** The account the engine runs on, in place of `cliAccount`'s default. The test catalog gives the test account
   *  home, and a benchmark cell, which runs with a HOME of its own, gives the operator's account home. */
  readonly account?: () => OsAccount;
  /** What this process observed about the logins, in place of this process's. */
  readonly observations?: LoginObservations;
  /** The platform whose token stores `/doctor` checks, in place of this process's. */
  readonly platform?: NodeJS.Platform;
  /** Decides whether an engine version may rotate in place; tests give one that runs no self-test. */
  readonly inPlaceGate?: (config: SelfTestConfig) => InPlaceGate;
}

/**
 * The host's default account: this process's home and the OS account's user. Each profile login overrides the
 * lookup home with its owning home, so a shared login reaches its original Keychain. Throws when the account
 * database has no entry for this process (`osAccount`).
 */
export function cliAccount(seams: ClaudeAgentSdkSeams): OsAccount {
  return seams.account?.() ?? { home: process.env.HOME || homedir(), user: osAccount().user };
}

/** What every engine of this process shares: the bundled engine, the account (`cliAccount`), this process's
 *  environment for the allowlist and its time zone, and this user's private engine temporary directory, made on first use. Throws when
 *  the account database names no account for this process, or when the temporary directory's name belongs to
 *  another user (`privateTemporaryRoot`). */
export function engineHost(seams: ClaudeAgentSdkSeams): EngineHost {
  return processEngineHost(cliAccount(seams), {
    ...(seams.enginePath === undefined ? {} : { enginePath: seams.enginePath }),
    ...(seams.cliEnvironment === undefined ? {} : { cliEnvironment: seams.cliEnvironment }),
  });
}

/** The engine launch for one credential, or why no engine can start for it. */
export type CliLaunch =
  | { readonly kind: "ready"; readonly config: QueryLauncherConfig }
  /** The credential is no Claude login with an absolute config directory. */
  | { readonly kind: "no-login" }
  /** The caller holds no launch authority, so no engine may start. */
  | { readonly kind: "no-launcher" }
  /** No engine host could be made: the account database names no account for this process, so nothing locates the
   *  login's keychain, or the engine temporary directory is not this user's. */
  | { readonly kind: "no-host"; readonly reason: string };

/** The one place that turns a credential into an engine launch, so the model listing asks the same engine and login
 *  that serves the queries. The token stays with the engine. */
export function cliLaunch(credential: RuntimeCredential | undefined, launcher: LauncherScope | undefined, seams: ClaudeAgentSdkSeams): CliLaunch {
  const configDir = credential?.type === "external" ? credential.configDir : undefined;
  if (configDir === undefined || !isAbsolute(configDir)) return { kind: "no-login" };
  if (launcher === undefined) return { kind: "no-launcher" };
  let host: EngineHost;
  try {
    host = engineHost(seams);
  } catch (cause) {
    return { kind: "no-host", reason: errorMessage(cause) };
  }
  return { kind: "ready", config: { ...host, account: { ...host.account, home: loginOwnerHome(configDir, host.account.home) }, configDir, launcher } };
}

/** The observations that the seams name, or this process's. */
export function observationsOf(seams: ClaudeAgentSdkSeams): LoginObservations {
  return seams.observations ?? processLoginObservations;
}
