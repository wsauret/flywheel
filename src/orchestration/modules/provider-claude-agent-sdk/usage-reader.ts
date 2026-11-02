import type { LauncherScope } from "../../../infra/process-supervisor.js";
import type { SubscriptionUsageOutcome, SubscriptionUsageReader, SubscriptionUsageReaderContext } from "../../../infra/llm/subscription-usage.js";
import { processUsageReadings, usageMetrics, usageReplyWindows, usageStatus, type UsageWindows } from "./account-usage.js";
import { cliLaunch, observationsOf, type ClaudeAgentSdkSeams } from "./cli-launch.js";
import { cliLogin } from "./cli-login.js";

/** The account's plan windows and when a source stated them, with no windows for a login that has none, or the
 *  outcome of a read that failed. */
type WindowsRead = { readonly windows: UsageWindows | undefined; readonly observedAtMs: number } | Exclude<SubscriptionUsageOutcome, { readonly kind: "success" }>;

/**
 * Asks the CLI that holds the account's login for the usage of the login, at background priority in a scope of the
 * runtime's launch authority that closes with the read, so a check never competes with a request or a project that
 * opens. The CLI reads the plan's usage with its own token, which Flywheel never sees. A CLI that cannot start, or an
 * unreadable reply fails the read, so the account's last reading stays on view. A valid reply without allowance
 * windows keeps its billing evidence and reports no meters.
 */
async function askCli(context: SubscriptionUsageReaderContext, seams: ClaudeAgentSdkSeams): Promise<WindowsRead> {
  const scope = context.launcher?.open({ priority: "background" });
  try {
    return await askCliIn(scope, context, seams);
  } finally {
    await scope?.close();
  }
}

async function askCliIn(launcher: LauncherScope | undefined, context: SubscriptionUsageReaderContext, seams: ClaudeAgentSdkSeams): Promise<WindowsRead> {
  const launch = cliLaunch(context.account.credential, launcher, seams);
  if (launch.kind !== "ready") return { kind: "fetch-failure" };
  try {
    // The Agent SDK loads only when a usage check asks a CLI, so a process that never does keeps it out of its start.
    const readUsage = seams.readUsage ?? (await import("./query-launcher.js")).readCliUsage;
    const usage = await readUsage(launch.config, context.signal);
    if (!usage.loggedIn) return { kind: "expired-auth" };
    if (usage.plan !== undefined) observationsOf(seams).recordPlan({ configDir: launch.config.configDir, accountId: context.account.instanceId }, usage.plan);
    const reply = usageReplyWindows(usage.reply);
    if (reply.kind === "unreadable") return { kind: "fetch-failure" };
    return { windows: reply.kind === "windows" ? reply.windows : undefined, observedAtMs: Date.now() };
  } catch {
    return { kind: "fetch-failure" };
  }
}

/**
 * The usage reader of the Claude accounts, which needs no Claude token. Its meters are the account's five-hour and
 * seven-day plan windows. While the account serves requests in this process, the windows come from the latest
 * rate-limit report of its CLI (`UsageReadings`), so no check starts a CLI; otherwise the reader asks the CLI that
 * holds the login. The account's automatic-billing source states whether Claude extra usage can bill it, from the
 * CLI's token-free config, so the paid-use question can ask about it (PI-MODEL-018) and the walk admits the account's
 * paid route only after the person allows it. A login that now holds another account states nothing about this one.
 */
export function claudeUsageReader(seams: ClaudeAgentSdkSeams): SubscriptionUsageReader {
  const readings = seams.usageReadings ?? processUsageReadings;
  return async (context) => {
    const { providerId, account } = context;
    if (account.credential.type !== "external" || account.identity === undefined) return { kind: "identity-unavailable" };
    const configDir = account.credential.configDir;
    const login = cliLogin(configDir);
    if (login?.account.accountId !== account.instanceId) return { kind: "identity-unavailable" };
    const read = readings.recent({ configDir, accountId: account.instanceId }, Date.now()) ?? await askCli(context, seams);
    if ("kind" in read) return read;
    const plan = login.account.plan ?? observationsOf(seams).plan({ configDir, accountId: account.instanceId });
    return { kind: "success", report: {
      providerId, instanceId: account.instanceId, identity: account.identity, providerStatus: usageStatus(read.windows), observedAtMs: read.observedAtMs,
      ...(plan === undefined ? {} : { plan }),
      metrics: usageMetrics(read.windows), spendSources: [{ kind: "automatic-billing", enablement: login.extraUsage }],
    } };
  };
}
