import type { AccessProviderDefinition, ExternalAccount, ExternalLoginPorts } from "../../../infra/llm/access-provider.js";
import type { AccessProviderFactory } from "../../agent-runtime/llm/client-factory.js";
import { moduleServiceHandle } from "../../../infra/module-service.js";
import type { ModuleServiceInstance, PortableModuleServices } from "../../app-service/module-service-host.js";
import type { FirstPartyModule } from "../../modules.js";
import { SEVEN_DAY_METRIC } from "./account-usage.js";
import { historicalEngineFraming } from "./agent-host/engine-text.js";
import { claudeSdkDynamicCatalog } from "./catalog.js";
import { engineHost, observationsOf, type ClaudeAgentSdkSeams } from "./cli-launch.js";
import { profileClaudeAccounts, loginClaudeAccount, logoutClaudeAccount, logoutProfileClaudeAccounts, type ClaudeProfile } from "./cli-login.js";
import { drainAgentHosts, releaseLiveBridges, resumeLiveBridges } from "./live-bridges.js";
import { claudeLoginHealth, loginProblems } from "./login-status.js";
import { prototypeLoginConversion, replacedSubscriptionConversion } from "./profile-conversions.js";
import { CLAUDE_AGENT_SDK_CLI_FLAG, CLAUDE_AGENT_SDK_LABEL, CLAUDE_AGENT_SDK_LOGIN_COMMAND, CLAUDE_AGENT_SDK_MODULE_ID, CLAUDE_AGENT_SDK_PROVIDER_ID, LOGIN_PROGRAM_LABEL } from "./names.js";
import { claudeUsageReader } from "./usage-reader.js";

/** The Claude accounts that the CLI holds for one auth profile, through its own login folders or explicit references. An
 *  account whose config names no plan takes the plan that a CLI of this process named for it. */
function profileAccounts(authDir: string, seams: ClaudeAgentSdkSeams): readonly ExternalAccount[] {
  const observations = observationsOf(seams);
  return profileClaudeAccounts(authDir, seams.account?.().home).map((found) => {
    const plan = found.plan ?? observations.plan(found);
    return plan === undefined ? found : { ...found, plan };
  });
}

/** The Claude logins of one auth profile, with this process's engine host and observations. */
function claudeProfile(authDir: string, seams: ClaudeAgentSdkSeams): ClaudeProfile {
  const observations = observationsOf(seams);
  return { authDir, host: engineHost(seams), accountHome: seams.account?.().home, forget: (ended) => { observations.forget(ended); } };
}

/** Runs the CLI's login, after which the account's last request no longer states anything about its login. */
async function login(authDir: string, ports: ExternalLoginPorts, seams: ClaudeAgentSdkSeams, previous?: ExternalAccount): Promise<ExternalAccount> {
  const account = await loginClaudeAccount(claudeProfile(authDir, seams), ports, previous);
  const observations = observationsOf(seams);
  if (ports.loginQuestionId === undefined) observations.clearRequest(account);
  else if (previous?.accountId !== account.accountId) {
    observations.clearRequest(account);
    throw new Error(`The login used a different account: ${account.identity}. Waiting runs for ${previous?.identity ?? "the refused account"} ended with the original login error.`);
  }
  return account;
}

/** The engine owns the login: it runs the OAuth flow, stores the token, and refreshes it. Each login is a config
 *  directory inside one auth profile, which Flywheel's login button creates and its logout removes. A separate home can
 *  reference that login without handling its token, and Disconnect removes only its reference. One account has one
 *  login location per profile, and Disconnect ends every location that holds it. Flywheel finds
 *  each account from the CLI's files in those directories and runs the CLI's own login and logout. Rank 0 makes it
 *  the first route for Claude models. */
function providerDefinition(seams: ClaudeAgentSdkSeams) {
  const accounts = (authDir: string) => profileAccounts(authDir, seams);
  const observations = observationsOf(seams);
  return {
    id: CLAUDE_AGENT_SDK_PROVIDER_ID,
    displayName: CLAUDE_AGENT_SDK_LABEL,
    shortName: "Anthropic Sub",
    supportedFamilies: ["anthropic"],
    defaultChatTransport: "anthropic-messages",
    configHints: [CLAUDE_AGENT_SDK_LOGIN_COMMAND],
    cli: { flag: CLAUDE_AGENT_SDK_CLI_FLAG, name: CLAUDE_AGENT_SDK_LABEL },
    billing: "subscription",
    paidModes: ["automatic"],
    rank: 0,
    // Claude accounts reset their seven-day windows at different moments.
    usage: { expiringWindow: SEVEN_DAY_METRIC },
    catalogId: "anthropic",
    dynamicCatalog: claudeSdkDynamicCatalog(seams),
    auth: {
      kind: "external",
      program: LOGIN_PROGRAM_LABEL,
      statusRank: 25,
      accounts,
      problems: (authDir) => loginProblems(accounts(authDir), seams),
      observe: (listener) => observationsOf(seams).observe(listener),
      awaitLogin: async (authDir, accountId, signal) => {
        signal.throwIfAborted();
        const account = accounts(authDir).find((candidate) => candidate.accountId === accountId);
        return account === undefined ? "declined" : await observations.awaitLogin(authDir, account, signal);
      },
      loginQuestions: () => observations.loginQuestions(),
      answerLogin: (id, answer) => observations.answerLogin(id, answer),
      settleLogin: (id, answer) => observations.settleLogin(id, answer),
      login: (authDir, ports, account) => login(authDir, ports, seams, account),
      logout: (authDir, accountId, ports) => logoutClaudeAccount(claudeProfile(authDir, seams), accountId, ports),
      logoutProfile: (authDir, ports) => logoutProfileClaudeAccounts(claudeProfile(authDir, seams), ports),
    },
    profileConversions: [replacedSubscriptionConversion(accounts), prototypeLoginConversion(accounts)],
  } as const satisfies AccessProviderDefinition;
}

const claudeAgentSdkService = moduleServiceHandle<ModuleServiceInstance>(CLAUDE_AGENT_SDK_MODULE_ID);

/** Turning the module off ends its effect (ARCH-STRUCTURE-026) without cancelling admitted work (ARCH-RUNTIME-063):
 *  every live engine use of the process lets its engine go, at once when idle and as soon as its open request ends
 *  otherwise, so a shared host closes when its last running request settled. The runner's next request then routes
 *  elsewhere. Any other selection change leaves the engines running: a host keeps the module capture that it took
 *  when it opened, whose gates refuse the calls of a module turned off since. Only the service's end at the process's
 *  shutdown closes every host at once. */
function createBridgeReleaseService(services: Pick<PortableModuleServices, "enabled" | "onSelectionChanged">): ModuleServiceInstance {
  const stop = services.onSelectionChanged(() => {
    if (services.enabled()) resumeLiveBridges();
    else releaseLiveBridges();
  });
  return { dispose: async () => {
    await stop();
    await drainAgentHosts();
  } };
}

/**
 * The Anthropic Subscription provider. It runs Claude through the `claude`
 * engine that ships with Flywheel, which owns the login and stays apart from the person's own `claude` installation, and it is
 * on by default. The bridge and the Agent SDK load only when
 * the first client is built, so a process that never serves Claude through it does not load them at start. `seams`
 * exist for fake-host scripts and tests only.
 */
export function createClaudeAgentSdkModule(seams: ClaudeAgentSdkSeams = {}) {
  const definition = providerDefinition(seams);
  const createClient: AccessProviderFactory = async (build) => (await import("./client.js")).createClaudeAgentSdkClient(build, seams);
  return {
    id: CLAUDE_AGENT_SDK_MODULE_ID,
    dependencies: [],
    availability: { kind: "available" },
    service: { handle: claudeAgentSdkService, portable: true, create: createBridgeReleaseService },
    contributions: [
      { domain: "providers", id: definition.id, value: { definition, createClient, usageReader: claudeUsageReader(seams) } },
      { domain: "health", id: CLAUDE_AGENT_SDK_MODULE_ID, value: {
        title: definition.displayName,
        check: (host) => claudeLoginHealth(host.authDirectory(), definition.auth.accounts, host.runOwnedCommand, seams),
      } },
      { domain: "settings", id: CLAUDE_AGENT_SDK_MODULE_ID, value: {
        control: "binary", group: "Model providers", label: definition.displayName,
        description: "Claude through its bundled engine, with a login for each profile",
      } },
    ],
    sessionHistory: { framing: historicalEngineFraming },
    observers: [],
    transformers: [],
    gates: [],
  } as const satisfies FirstPartyModule;
}

export const claudeAgentSdkModule = createClaudeAgentSdkModule();
