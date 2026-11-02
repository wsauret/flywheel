import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import { isExternalLoginDefinition, type ExternalAccount } from "../../../../infra/llm/access-provider.js";
import { openExternalUrl } from "../../../../infra/open-external-url.js";
import type { LauncherScope } from "../../../../infra/process-supervisor.js";
import type { CliNounContribution, CliVerb } from "../../../cli-contribution.js";
import { installedAccessProviderDefinitions } from "../../../credential-provider-modules.js";
import { CLAUDE_SDK_PROFILE, setupClaudeSdkHome, setupClaudeSdkProfile } from "../claude-sdk/setup.js";

const SCENARIO_NAMES = ["chat", "child", "title", "workflow", "stop"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** The installed Agent SDK provider's external login. */
function claudeLogin() {
  const provider = installedAccessProviderDefinitions().filter(isExternalLoginDefinition).find(({ id }) => id === "claude_agent_sdk");
  if (provider === undefined) throw new Error("The installed catalog has no Agent SDK provider");
  return provider.auth;
}

/** The Claude accounts that the installed Agent SDK provider finds for an auth profile's directory. */
function claudeAccounts(authDirectory: string): readonly ExternalAccount[] {
  return claudeLogin().accounts(authDirectory);
}

/** One line that the person types at the terminal, such as the code that the Claude sign-in page shows. A question
 *  that `lines` closes before an answer never settles, because the login that asked it no longer needs it. */
function terminalLine(lines: Interface, question: string): Promise<string> {
  return new Promise((settle) => { lines.question(question, settle); });
}

/** Logs in to a new Claude login of the profile in `authDirectory` with the provider's own login, as the login button
 *  of that profile does. This process's HOME stays the CLI's HOME, so the CLI keeps the token in the person's own
 *  keychain while the login's config directory lies in the prepared home. The terminal prompt for a pasted code
 *  closes when the login ends: a login that the browser finishes leaves no open prompt that keeps the command alive. */
async function loginToProfile(authDirectory: string, launcher: LauncherScope): Promise<ExternalAccount> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await claudeLogin().login(authDirectory, {
      launcher,
      openBrowser: (url) => openExternalUrl(launcher, url),
      onAuthorizeUrl: ({ url }) => { console.log(`If a browser did not open, open this URL:\n  ${url}`); },
      onManualCodeInput: () => terminalLine(lines, "Paste the code that the page shows: "),
    });
  } finally {
    lines.close();
  }
}

const setupVerb: CliVerb = {
  syntax: "setup [--home <dir> [--profile-only]] [--model <id>] [--login]",
  description: "Prepare a Flywheel home that runs every role through a Claude CLI login of its claude-sdk profile, or add only that profile to an account; --login adds a login to the profile",
  runsWhileOff: true,
  run: async (args, context) => {
    const { values } = parseArgs({ args: [...args], options: {
      home: { type: "string" }, model: { type: "string" }, "profile-only": { type: "boolean" }, login: { type: "boolean" },
    } });
    const profileOnly = values["profile-only"] === true;
    if (profileOnly && (values.home === undefined || values.model !== undefined)) {
      console.error("--profile-only adds the auth profile to an account that exists, so it needs --home and pins no model.");
      process.exitCode = 2;
      return;
    }
    const accountHome = values.home === undefined ? mkdtempSync(join(tmpdir(), "flywheel-claude-sdk-")) : resolve(values.home);
    const userDataRoot = join(accountHome, ".flywheel");
    const result = profileOnly
      ? await setupClaudeSdkProfile({ userDataRoot, accounts: claudeAccounts })
      : await setupClaudeSdkHome({ userDataRoot, accounts: claudeAccounts, ...(values.model === undefined ? {} : { model: values.model }) });
    const accounts = values.login === true ? [...result.accounts, await loginToProfile(result.authDirectory, context.launcher.scope)] : result.accounts;
    console.log(`Flywheel home: ${accountHome}`);
    console.log(accounts.length === 0
      ? `Claude accounts: none. Run this setup again with --home ${accountHome} --login to log in to the ${CLAUDE_SDK_PROFILE} profile.`
      : `Claude accounts: ${accounts.map(({ identity, configDir }) => `${identity} (${configDir})`).join(", ")}`);
    if (profileOnly) {
      console.log(`Auth profile: ${CLAUDE_SDK_PROFILE}. The settings, the module selection, and the active profile are unchanged.`);
      console.log(`Select the profile with FLYWHEEL_AUTH_PROFILE=${CLAUDE_SDK_PROFILE}.`);
    } else console.log(`Active auth profile: ${CLAUDE_SDK_PROFILE}`);
    if (values.home === undefined) console.log(`Run Flywheel against it with HOME=${accountHome}`);
  },
};

const scenarioVerb: CliVerb = {
  syntax: `scenario <${SCENARIO_NAMES.join("|")}> --home <dir>`,
  description: "Run one scenario through production composition, in an isolated project, on the Claude login of the claude-sdk profile of a home that setup --login prepared",
  run: async (args, context) => {
    const { positionals, values } = parseArgs({ args: [...args], allowPositionals: true, options: { home: { type: "string" } } });
    const name = SCENARIO_NAMES.find((candidate) => candidate === positionals[0]);
    if (name === undefined || values.home === undefined) {
      console.error(`Usage: flywheel claude-sdk ${scenarioVerb.syntax}`);
      process.exitCode = 2;
      return;
    }
    // The runtime composition reads the installed module catalog when it loads, and this file loads while the
    // catalog itself is being installed, so the scenario code loads only when a scenario runs.
    const { runScenario } = await import("../claude-sdk/scenarios.js");
    const report = await runScenario(name, { accounts: claudeAccounts, launcher: context.launcher.scope, accountHome: resolve(values.home) });
    console.log(JSON.stringify(report, null, 1));
    if (!report.completed) process.exitCode = 1;
  },
};

/** Operator verbs for the Agent SDK provider: a home for its benchmark arm, and its live scenarios. */
export const claudeSdkNoun = {
  usage: "Usage: flywheel claude-sdk <setup|scenario> [args]",
  verbs: { setup: setupVerb, scenario: scenarioVerb },
} as const satisfies CliNounContribution;
