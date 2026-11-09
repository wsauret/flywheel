import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refusingLauncher } from "../../../../helpers/launcher-fake.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import { isExternalLoginDefinition } from "../../../../../src/infra/llm/access-provider.js";
import { cliLaunch } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { createClaudeAgentSdkModule } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { usageReadings } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/account-usage.js";
import type { CliUsage } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { updateModuleMember } from "../../../../../src/orchestration/config/module-selection-writer.js";
import { composeFirstPartyModules, moduleProtocolRows, moduleSelectionFromConfig, SHIPPED_MODULES } from "../../../../../src/orchestration/modules.js";
import { MODULE_IDS } from "../../../../../src/protocol/module-ids.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import type { ClaudeAgentSdkSeams } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { enginePath } from "../../../../../src/infra/claude-engine.js";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js";
import { registerHostDrain, registerLiveBridge } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/live-bridges.js";
import { moduleProcessServices } from "../../../../helpers/module-kernel.js";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();
const ID = "provider-claude-agent-sdk";

/** The config directory of the one Claude login of the default profile in the Flywheel home of `home`. */
function loginDir(home: string): string {
  return join(home, ".flywheel", "auth", "profiles", "default", LOGIN_ACCOUNTS_DIRECTORY, "a");
}

/** Writes the CLI's global config of that login, as the CLI does after a login. */
function writeLogin(home: string, text: string): void {
  mkdirSync(loginDir(home), { recursive: true });
  writeFileSync(join(loginDir(home), ".claude.json"), text);
}

/** The part of the Claude CLI's global config that the usage reader reads. */
interface CliConfig {
  readonly oauthAccount?: { readonly [key: string]: unknown };
  readonly cachedExtraUsageDisabledReason?: string | null;
}

describe("the Agent SDK provider module", () => {
  test("one refusal owns joined waits, one answer, and a decline until the account recovers", async () => {
    const fixture = recoveryFixture();
    const { auth, observations, account, authDir } = fixture;
    const records = spyOn(DebugLog, "record");
    try {
      const first = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
      const signal = new AbortController().signal;
      const removed = spyOn(signal, "removeEventListener");
      const second = auth.awaitLogin(authDir, account.accountId, signal);
      const question = auth.loginQuestions()[0]!;
      expect(auth.loginQuestions()).toHaveLength(1);
      expect(auth.answerLogin("stale", "declined")).toBeUndefined();
      expect(auth.answerLogin(question.id, "declined")).toMatchObject({ id: question.id });
      expect(await first).toBe("declined");
      expect(await second).toBe("declined");
      expect(removed).toHaveBeenCalledTimes(1);
      expect(records.mock.calls.map(([record]) => record)).toEqual([
        { type: "provider.claude_sdk.login.condition", payload: { questionId: question.id, decision: "asking", waiters: 0 } },
        { type: "provider.claude_sdk.login.condition", payload: { questionId: question.id, decision: "declined", waiters: 2 } },
      ]);
      expect(auth.loginQuestions()).toEqual([]);
      observations.recordRequest(account, "program-exited");
      expect(auth.problems(authDir)[0]?.kind).toBe("login-rejected");
      observations.recordRequest(account, "login-rejected");
      const count = records.mock.calls.length;
      for (let i = 0; i < 5; i++) expect(await auth.awaitLogin(authDir, account.accountId, new AbortController().signal)).toBe("declined");
      expect(records.mock.calls).toHaveLength(count);
      observations.recordRequest(account, "served");
      const renewed = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
      expect(await renewed).toBe("renewed");
      observations.recordRequest(account, "login-rejected");
      const third = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
      const next = auth.loginQuestions()[0]!;
      expect(next.id).not.toBe(question.id);
      expect(auth.answerLogin(next.id, "renewed")).toMatchObject({ phase: "logging-in" });
      expect(auth.answerLogin(next.id, "renewed")).toBeUndefined();
      expect(auth.answerLogin(next.id, "declined")).toBeUndefined();
      auth.settleLogin(question.id, "declined");
      expect(auth.loginQuestions()[0]?.id).toBe(next.id);
      auth.settleLogin(next.id, "renewed");
      expect(await third).toBe("renewed");
      expect(auth.problems(authDir)).toEqual([]);
    } finally {
      records.mockRestore();
    }
  });

  test("Stop removes only its waiter and all settlements remove abort listeners", async () => {
    const { auth, authDir, account, observations } = recoveryFixture();
    const before = new AbortController();
    const reason = new Error("stopped");
    before.abort(reason);
    await expect(auth.awaitLogin(authDir, account.accountId, before.signal)).rejects.toBe(reason);
    expect(auth.loginQuestions()).toEqual([]);
    const first = new AbortController();
    const second = new AbortController();
    const removeFirst = spyOn(first.signal, "removeEventListener");
    const removeSecond = spyOn(second.signal, "removeEventListener");
    const stopped = auth.awaitLogin(authDir, account.accountId, first.signal);
    const remaining = auth.awaitLogin(authDir, account.accountId, second.signal);
    const id = auth.loginQuestions()[0]!.id;
    first.abort(reason);
    await expect(stopped).rejects.toBe(reason);
    expect(auth.loginQuestions()[0]?.id).toBe(id);
    observations.recordRequest(account, "served");
    expect(await remaining).toBe("renewed");
    expect(removeFirst).toHaveBeenCalledTimes(1);
    expect(removeSecond).toHaveBeenCalledTimes(1);
    observations.recordRequest(account, "login-rejected");
    const last = new AbortController();
    const wait = auth.awaitLogin(authDir, account.accountId, last.signal);
    const newId = auth.loginQuestions()[0]!.id;
    second.abort(reason);
    last.abort(reason);
    await expect(wait).rejects.toBe(reason);
    expect(auth.loginQuestions()[0]?.id).toBe(newId);
    const joined = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
    auth.answerLogin(newId, "declined");
    expect(await joined).toBe("declined");
  });

  test("automatic same-account login waits for settlement; another account stays discoverable but cannot renew it", async () => {
    for (const outcome of ["renewed", "declined", "different"] as const) {
      const different = outcome === "different";
      const { auth, authDir, account, home } = recoveryFixture();
      const wait = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
      const question = auth.loginQuestions()[0]!;
      auth.answerLogin(question.id, "renewed");
      let settled = false;
      void wait.then(() => { settled = true; });
      const login = auth.login(authDir, { launcher: loginLauncher(home, different ? "uuid-other" : account.accountId), loginQuestionId: question.id }, account);
      if (different) {
        await expect(login).rejects.toThrow("different account");
        // The location no longer holds the refused account, so its question and waiting runs end before settlement.
        expect(await wait).toBe("declined");
        expect(auth.loginQuestions()).toEqual([]);
        expect(auth.accounts(authDir)[0]?.accountId).toBe("uuid-other");
        continue;
      }
      expect((await login).accountId).toBe(account.accountId);
      expect(settled).toBe(false);
      expect(auth.loginQuestions()[0]?.phase).toBe("logging-in");
      auth.settleLogin(question.id, outcome);
      expect(await wait).toBe(outcome);
    }
  });

  test("a reconnect as another account forgets the replaced account's condition before the replacement serves", async () => {
    const { auth, authDir, account, home, observations } = recoveryFixture();
    const wait = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
    let questions: readonly unknown[] | undefined;
    const stop = auth.observe(() => { questions ??= auth.loginQuestions(); });
    try {
      const replacement = await auth.login(authDir, { launcher: loginLauncher(home, "uuid-other") }, account);

      expect(replacement.accountId).toBe("uuid-other");
      expect(await wait).toBe("declined");
      expect(questions).toEqual([]);
      expect(observations.outcome(account)).toBeUndefined();
      expect(auth.accounts(authDir).map(({ accountId }) => accountId)).toEqual(["uuid-other"]);
    } finally {
      stop();
    }
  });

  test("Disconnect forgets the login's condition: a parked wait ends declined, the question goes, the auth view hears it, and a renewed answer starts no login", async () => {
    const { auth, authDir, account, observations } = recoveryFixture();
    const wait = auth.awaitLogin(authDir, account.accountId, new AbortController().signal);
    const question = auth.loginQuestions()[0]!;
    let published = 0;
    const stop = auth.observe(() => { published += 1; });
    const commands: (readonly string[])[] = [];
    const launcher: LauncherScope = {
      ...refusingLauncher,
      spawnOwned: async (command) => {
        commands.push(command.slice(1));
        const closed = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
        const exit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" } as const;
        return { pid: 42, token: "fake", stdin: undefined, stdout: closed(), stderr: closed(), exited: Promise.resolve(exit), terminate: async () => exit };
      },
    };
    try {
      await auth.logout(authDir, account.accountId, { launcher });

      expect(await wait).toBe("declined");
      expect(auth.loginQuestions()).toEqual([]);
      expect(published).toBe(1);
      expect(observations.outcome(account)).toBeUndefined();
      expect(auth.answerLogin(question.id, "renewed")).toBeUndefined();
      expect(commands).toEqual([["auth", "logout"]]);
    } finally {
      stop();
    }
  });

  test.each(["Disconnect", "profile logout"] as const)("%s of a profile that references a login forgets the login's condition and leaves the login", async (action) => {
    const { auth, home, account } = recoveryFixture();
    const workAuthDir = join(home, ".flywheel", "auth", "profiles", "work");
    mkdirSync(join(workAuthDir, LOGIN_ACCOUNTS_DIRECTORY), { recursive: true });
    writeFileSync(join(workAuthDir, LOGIN_ACCOUNTS_DIRECTORY, "shared.reference.json"), JSON.stringify({ version: 1, configDir: account.configDir }));
    const wait = auth.awaitLogin(workAuthDir, account.accountId, new AbortController().signal);
    const question = auth.loginQuestions()[0]!;
    let published = 0;
    const stop = auth.observe(() => { published += 1; });
    try {
      // The refusing launcher proves that removing a reference runs no CLI.
      if (action === "Disconnect") await auth.logout(workAuthDir, account.accountId, { launcher: refusingLauncher });
      else await auth.logoutProfile(workAuthDir, { launcher: refusingLauncher });

      expect(await wait).toBe("declined");
      expect(auth.loginQuestions()).toEqual([]);
      expect(published).toBe(1);
      expect(auth.answerLogin(question.id, "renewed")).toBeUndefined();
      expect(auth.accounts(workAuthDir)).toEqual([]);
      expect(auth.accounts(join(home, ".flywheel", "auth", "profiles", "default")).map(({ accountId }) => accountId)).toEqual([account.accountId]);
    } finally {
      stop();
    }
  });

  test("a release installs it and turns it on for a selection that states nothing", () => {
    const selection = moduleSelectionFromConfig({});
    if (!selection.ok) throw new Error(selection.error);

    expect(selection.moduleIds).toContain(ID);
    expect(composeFirstPartyModules(SHIPPED_MODULES, []).enabledModuleIds).toContain(ID);
  });

  test("its Settings row is an ordinary provider row that turns off and on again", async () => {
    const row = moduleProtocolRows(MODULE_IDS, SHIPPED_MODULES).find((candidate) => candidate.id === ID);
    expect(row).toMatchObject({ installed: true, effective: true, setting: { control: "binary", group: "Model providers", label: "Anthropic Subscription" } });

    const configPath = `${temporaryDirectory("claude-sdk-module-")}/flywheel.toml`;
    expect(await updateModuleMember(ID, true, false, { configPath })).toEqual({ ok: true });
    expect(await updateModuleMember(ID, false, true, { configPath })).toEqual({ ok: true });
  });

  test("its process service lets every live engine use go when the module is turned off, leaves them on another module's change, and closes the shared agent hosts at once only at its end", async () => {
    const service = createClaudeAgentSdkModule().service;
    if (service === undefined) throw new Error("the module declares no process service");
    let enabled = true;
    const listeners: (() => void | Promise<void>)[] = [];
    let releases = 0;
    let resumes = 0;
    let drains = 0;
    const unregisterDrain = registerHostDrain(async () => { drains += 1; });
    const unregister = registerLiveBridge(() => { releases += 1; }, () => { resumes += 1; });
    const ports = moduleProcessServices({ enabled: () => enabled, onSelectionChanged: (listener) => { listeners.push(listener); return () => {}; } });
    const instance = service.create(ports);
    try {
      // Another module turns off or on: admitted work keeps its engines (ARCH-RUNTIME-063).
      for (const listener of listeners) await listener();
      expect({ releases, resumes, drains }).toEqual({ releases: 0, resumes: 1, drains: 0 });
      enabled = false;
      for (const listener of listeners) await listener();
      // Each use lets its engine go once its request settled, so the service closes no host itself.
      expect({ releases, resumes, drains }).toEqual({ releases: 1, resumes: 1, drains: 0 });
      // Turned on again, each use that still lets its engine go at its request's end keeps it.
      enabled = true;
      for (const listener of listeners) await listener();
      expect({ releases, resumes, drains }).toEqual({ releases: 1, resumes: 2, drains: 0 });
      await instance.dispose();
      expect(drains).toBe(1);
    } finally {
      unregister();
      unregisterDrain();
      await instance.dispose();
    }
  });

  test("runs the engine with this process's HOME, where the engine keeps the keychain of a login made there, and each profile serves only its own logins, never the person's own `claude` login of that HOME", () => {
    const home = temporaryDirectory("claude-sdk-home-");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
    writeLogin(home, JSON.stringify({ oauthAccount: { accountUuid: "uuid-sandbox", emailAddress: "sandbox@example.com" } }));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      // The launch is read first: it reads no Claude file, so a home from anywhere else fails here before any read.
      const launch = cliLaunch({ type: "external", configDir: loginDir(home) }, refusingLauncher, { enginePath: "/scratch/bin/claude" });
      expect(launch.kind === "ready" ? launch.config.account.home : launch.kind).toBe(home);
      const owner = temporaryDirectory("claude-login-owner-");
      const shared = cliLaunch({ type: "external", configDir: loginDir(owner) }, refusingLauncher, { enginePath: "/scratch/bin/claude" });
      expect(shared.kind === "ready" ? shared.config.account.home : shared.kind).toBe(owner);
      const [provider] = createClaudeAgentSdkModule().contributions;
      const definition = provider.value.definition;
      const accounts = (profile: string) => isExternalLoginDefinition(definition) ? definition.auth.accounts(join(home, ".flywheel", "auth", "profiles", profile)) : [];
      expect(accounts("default")).toEqual([{ accountId: "uuid-sandbox", identity: "sandbox@example.com", configDir: loginDir(home) }]);
      expect(accounts("work")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });

  test("states a refused login, an exited engine, and an engine that cannot start as the problems of the profile's logins, with the plan that the engine named and with no account email in the text, and a served request clears the account's problem", () => {
    const home = temporaryDirectory("claude-sdk-problems-");
    writeLogin(home, JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
    const observations = createLoginObservations();
    const changes: number[] = [];
    const login = { configDir: loginDir(home), accountId: "uuid-person" };
    const definition = externalDefinition({ account: () => ({ home, user: "tester" }), observations });
    const authDir = join(home, ".flywheel", "auth", "profiles", "default");
    const unsubscribe = definition.auth.observe(() => { changes.push(changes.length); });

    expect(definition.auth.problems(authDir)).toEqual([]);
    observations.recordPlan(login, "Claude Max");
    observations.recordRequest(login, "login-rejected");
    expect(definition.auth.accounts(authDir)).toEqual([expect.objectContaining({ accountId: "uuid-person", plan: "Claude Max" })]);
    expect(definition.auth.problems(authDir)).toEqual([
      { kind: "login-rejected", accountId: "uuid-person", message: "Claude refused this account's login in this profile. Log in again." },
    ]);
    observations.recordRequest(login, "program-exited");
    expect(definition.auth.problems(authDir)).toEqual([
      { kind: "program-exited", accountId: "uuid-person", message: "The Claude engine exited while it served a request of this account. Flywheel starts it again for the next request." },
    ]);
    observations.recordRequest(login, "program-cannot-start");
    expect(definition.auth.problems(authDir)).toEqual([
      { kind: "program-cannot-start", accountId: "uuid-person", message: expect.stringMatching(/^The Claude engine that ships with Flywheel cannot start on this machine\..*Reinstall Flywheel/u) },
    ]);
    observations.recordRequest(login, "served");
    expect(definition.auth.problems(authDir)).toEqual([]);
    // Each change tells the auth view once; a repeated observation tells it nothing.
    observations.recordRequest(login, "served");
    expect(changes).toHaveLength(5);
    unsubscribe();
  });

  test("its /doctor section names the engine that ships with Flywheel, the version that the engine states, each account with its plan, status, login folder, token store, and last request, and each login folder that serves no account", async () => {
    const home = temporaryDirectory("claude-sdk-doctor-");
    const person = { accountUuid: "uuid-person", emailAddress: "person@example.com", planDisplayName: "Claude Max" };
    writeLogin(home, JSON.stringify({ oauthAccount: person }));
    // The doctor reads only that the file exists, so the text is no token.
    writeFileSync(join(loginDir(home), ".credentials.json"), "not read");
    const folders = join(loginDir(home), "..");
    mkdirSync(join(folders, "b"));
    mkdirSync(join(folders, "c"));
    writeFileSync(join(folders, "c", ".claude.json"), JSON.stringify({ oauthAccount: person }));
    const unserved = [`Login folder ${join(folders, "b")} holds no Claude login.`, `Login folder ${join(folders, "c")} holds person@example.com, which an earlier login folder serves.`];
    const details = (last: string) => `person@example.com login folder: ${loginDir(home)}. Token store: the credentials file in the login folder. Last request in this process: ${last}.`;
    const observations = createLoginObservations();
    const asked: (readonly string[])[] = [];
    let answer: Pick<OwnedCommandResult, "exitCode" | "stdout"> = { exitCode: 0, stdout: "2.1.296 (Claude Code)\n" };
    const run: OwnedCommandRunner = async (command) => {
      asked.push(command);
      return { ...answer, stdoutBytes: new TextEncoder().encode(answer.stdout), stderr: "", timedOut: false };
    };
    const module = createClaudeAgentSdkModule({ account: () => ({ home, user: "tester" }), observations });
    const health = module.contributions.find((contribution) => contribution.domain === "health")?.value;
    const host = { directories: testDirectories(home), authDirectory: () => join(home, ".flywheel", "auth", "profiles", "default"), runOwnedCommand: run };
    if (health === undefined || !("check" in health)) throw new Error("the module contributes no health check");

    expect(health.title).toBe("Anthropic Subscription");
    expect(await health.check(host)).toEqual({ attention: false, lines: [
      `Claude engine: version 2.1.296, at ${enginePath()}.`,
      "person@example.com (Claude Max): logged in",
      details("none yet"),
      ...unserved,
    ] });
    expect(asked).toEqual([[enginePath(), "--version"]]);

    observations.recordRequest({ configDir: loginDir(home), accountId: "uuid-person" }, "served");
    expect((await health.check(host)).lines[2]).toBe(details("served"));

    observations.recordRequest({ configDir: loginDir(home), accountId: "uuid-person" }, "login-rejected");
    answer = { exitCode: 1, stdout: "" };
    expect(await health.check(host)).toEqual({ attention: true, lines: [
      `The Claude engine at ${enginePath()} does not run: its --version call exited with code 1. Reinstall Flywheel, or run bun install in a source checkout.`,
      "person@example.com (Claude Max): Claude refused this account's login in this profile. Log in again.",
      details("login refused"),
      ...unserved,
    ] });

    expect((await health.check({ ...host, runOwnedCommand: undefined })).lines[0]).toBe(`Claude engine: ${enginePath()}. This runtime starts no program, so the engine's version is not read.`);

    // An account record with no token is no login: the engine's next request fails, so the doctor names the remedy.
    rmSync(join(loginDir(home), ".credentials.json"));
    answer = { exitCode: 0, stdout: "2.1.296 (Claude Code)\n" };
    const linux = createClaudeAgentSdkModule({ account: () => ({ home, user: "tester" }), observations: createLoginObservations(), platform: "linux" });
    const linuxHealth = linux.contributions.find((contribution) => contribution.domain === "health")?.value;
    if (linuxHealth === undefined || !("check" in linuxHealth)) throw new Error("the module contributes no health check");
    expect(await linuxHealth.check(host)).toEqual({ attention: true, lines: [
      `Claude engine: version 2.1.296, at ${enginePath()}.`,
      "person@example.com (Claude Max): needs login, because no token is stored for this account. Log in again from Authentication.",
      `person@example.com login folder: ${loginDir(home)}. Token store: none. Last request in this process: none yet.`,
      ...unserved,
    ] });
  });

  test("reports whether Claude extra usage can bill each account, from the CLI's token-free config, so the paid-use question can ask about it", async () => {
    const usage = usageFixture();
    const read = async (config: CliConfig) => {
      const outcome = await usage.read(config);
      return outcome.kind === "success" ? outcome.report : outcome.kind;
    };
    const oauthAccount = { accountUuid: "uuid-person", emailAddress: "person@example.com" };

    // The CLI records the service's reason after each response, and null when no reason keeps extra usage off.
    expect(await read({ oauthAccount, cachedExtraUsageDisabledReason: null })).toMatchObject({
      providerId: "claude_agent_sdk", instanceId: "uuid-person", identity: "person@example.com", spendSources: [{ kind: "automatic-billing", enablement: "enabled" }],
    });
    const enablement = async (config: CliConfig) => {
      const report = await read({ oauthAccount, ...config });
      return typeof report === "string" ? report : report.spendSources?.map((source) => (source.kind === "automatic-billing" ? source.enablement : source.kind));
    };
    expect(await enablement({ cachedExtraUsageDisabledReason: "org_level_disabled" })).toEqual(["disabled"]);
    expect(await enablement({ cachedExtraUsageDisabledReason: "out_of_credits" })).toEqual(["disabled"]);
    expect(await enablement({ cachedExtraUsageDisabledReason: "fetch_error" })).toEqual(["unknown"]);
    // Before its first response the CLI has only the account profile that its login read.
    expect(await enablement({ oauthAccount: { ...oauthAccount, hasExtraUsageEnabled: true } })).toEqual(["enabled"]);
    expect(await enablement({ oauthAccount: { ...oauthAccount, hasExtraUsageEnabled: false } })).toEqual(["disabled"]);
    expect(await enablement({})).toEqual(["unknown"]);
    // Another account's login in the directory is not this account's evidence, so no CLI is asked about it.
    const asked = usage.asked.length;
    expect(await read({ oauthAccount: { accountUuid: "uuid-other", emailAddress: "other@example.com" }, cachedExtraUsageDisabledReason: null })).toBe("identity-unavailable");
    expect(usage.asked).toHaveLength(asked);
  });

  test("shows the account's all-models weekly window first, then five-hour usage, then each weekly window of one model under its name, from the CLI's reply when no recent report holds them", async () => {
    const fable = { display_name: "Fable", utilization: 2, resets_at: "2027-01-16T14:00:00.505722+00:00" };
    const usage = usageFixture({ loggedIn: true, plan: "Claude Max", reply: {
      subscription_type: "max", rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2027-01-15T10:00:00.000Z" }, seven_day: { utilization: 17.5, resets_at: null }, seven_day_opus: { utilization: 3, resets_at: null },
        // An entry without a name or a numeric utilization states nothing.
        model_scoped: [fable, { display_name: "Opus", utilization: null, resets_at: null }, { utilization: 5, resets_at: null }, "Sonnet"],
      },
    } });

    const outcome = await usage.read(LOGGED_IN);

    expect(outcome).toMatchObject({ kind: "success", report: { providerStatus: "ok", plan: "Claude Max", metrics: [
      { metricKey: "seven_day", label: "Seven days (all models)", rank: 0, scope: { kind: "account" }, timing: { kind: "unavailable" }, usedFraction: 0.175, used: { kind: "percentage", value: 0.175, provenance: "provider", precision: "exact" } },
      { metricKey: "five_hour", label: "Five hours", rank: 1, scope: { kind: "account" }, timing: { kind: "unavailable", resetAtMs: Date.parse("2027-01-15T10:00:00.000Z") }, usedFraction: 0.42, used: { kind: "percentage", value: 0.42, provenance: "provider", precision: "exact" } },
      { metricKey: "seven_day_overage_included", label: "Seven days (Fable)", rank: 2, scope: { kind: "feature", featureKey: "Fable" }, timing: { kind: "unavailable", resetAtMs: Date.parse(fable.resets_at) }, usedFraction: 0.02, used: { kind: "percentage", value: 0.02, provenance: "provider", precision: "exact" } },
    ] } });
    expect(outcome.kind === "success" ? outcome.report.metrics : []).toHaveLength(3);
    // The CLI that answers runs on the account's own login, at background priority in a scope of the runtime's launch
    // authority that the read closes, so a usage check never competes with a request.
    expect(usage.asked).toEqual([loginDir(usage.home)]);
    expect(usage.scopes).toEqual([{ policy: { priority: "background" }, launches: 1, closed: true }]);
    // A login without plan windows, such as a Console login, has no meters.
    usage.answer({ loggedIn: true, reply: { subscription_type: null, rate_limits_available: false, rate_limits: null } });
    // The plan that a CLI of this process named stays on view while a later reply names none.
    expect(await usage.read(LOGGED_IN)).toMatchObject({ kind: "success", report: { providerStatus: "unknown", plan: "Claude Max", metrics: [] } });
    // A valid report without allowance windows still carries the account's billing evidence.
    usage.answer({ loggedIn: true, reply: { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: null, seven_day: null, seven_day_opus: { utilization: 3, resets_at: null } } } });
    expect(await usage.read(LOGGED_IN)).toMatchObject({ kind: "success", report: {
      providerStatus: "unknown", plan: "Claude Max", metrics: [],
      spendSources: [{ kind: "automatic-billing", enablement: "enabled" }],
    } });
    // A full window of one model spends that model's allowance only, so the account stays in service.
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: null }, model_scoped: [{ ...fable, utilization: 100 }] } } });
    expect(await usage.read(LOGGED_IN)).toMatchObject({ kind: "success", report: { providerStatus: "ok", metrics: [{ metricKey: "seven_day" }, { metricKey: "seven_day_overage_included", usedFraction: 1 }] } });
  });

  test("names the unnamed weekly window of one model that a rate-limit report carries with the one model window that the CLI's last reply named, and keeps the reply's windows when it named several", async () => {
    const usage = usageFixture();
    const now = Date.now();
    const login = { configDir: loginDir(usage.home), accountId: "uuid-person" };
    const weekly = { usedFraction: 0.4, resetsAtMs: now + 86_400_000 };
    const modelMetric = (read: Awaited<ReturnType<typeof usage.read>>) => read.kind === "success" ? read.report.metrics.filter((metric) => metric.scope.kind === "feature") : read.kind;
    const eventModel = (usedFraction: number) => ({ usedFraction, resetsAtMs: now + 86_400_000, metricKey: "seven_day_overage_included" });

    // Before any reply in this process names the model, the report's window shows under a label that names no model.
    usage.readings.record(login, { sevenDay: weekly, models: [eventModel(0.03)] }, now - 60_000);
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual([expect.objectContaining({ metricKey: "seven_day_overage_included", label: "Seven days (one model)", rank: 2, usedFraction: 0.03 })]);

    // A reply that names one model window names the report's window; the metric key does not change.
    const resetsAt = new Date(now + 86_400_000).toISOString();
    usage.readings.record(login, { sevenDay: weekly }, now - 6 * 60_000);
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: resetsAt }, model_scoped: [{ display_name: "Fable", utilization: 2, resets_at: resetsAt }] } } });
    const replied = modelMetric(await usage.read(LOGGED_IN));
    expect(replied).toEqual([expect.objectContaining({ metricKey: "seven_day_overage_included", label: "Seven days (Fable)", usedFraction: 0.02 })]);
    usage.readings.record(login, { sevenDay: weekly, models: [eventModel(0.05)] }, now);
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual([expect.objectContaining({ metricKey: "seven_day_overage_included", label: "Seven days (Fable)", usedFraction: 0.05 })]);
    // A report without the window keeps the window that the reply stated, so the meter stays on view.
    usage.readings.record(login, { sevenDay: weekly }, now);
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual(replied);
    expect(usage.asked).toHaveLength(1);

    // A reply that leaves the model list out states nothing about it, so the named window stays on view and keeps its name.
    usage.readings.record(login, { sevenDay: weekly }, now - 6 * 60_000);
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: resetsAt } } } });
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual(replied);
    usage.readings.record(login, { sevenDay: weekly, models: [eventModel(0.06)] }, now);
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual([expect.objectContaining({ label: "Seven days (Fable)", usedFraction: 0.06 })]);

    // A named window whose reset the reply does not state stays on view when a report carries no model window.
    usage.readings.record(login, { sevenDay: weekly }, now - 6 * 60_000);
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: resetsAt }, model_scoped: [{ display_name: "Fable", utilization: 9, resets_at: null }] } } });
    await usage.read(LOGGED_IN);
    usage.readings.record(login, { sevenDay: weekly }, now);
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual([expect.objectContaining({ label: "Seven days (Fable)", usedFraction: 0.09, timing: { kind: "unavailable" } })]);

    // With several named windows the report cannot say which one it states, so the reply's windows stay as it stated them.
    usage.readings.record(login, { sevenDay: weekly }, now - 6 * 60_000);
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: resetsAt }, model_scoped: [
      { display_name: "Fable", utilization: 2, resets_at: resetsAt }, { display_name: "Opus", utilization: 7, resets_at: resetsAt },
    ] } } });
    await usage.read(LOGGED_IN);
    usage.readings.record(login, { sevenDay: weekly, models: [eventModel(0.5)] }, now);
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual([
      expect.objectContaining({ metricKey: "seven_day_overage_included:Fable", usedFraction: 0.02 }), expect.objectContaining({ metricKey: "seven_day_overage_included:Opus", usedFraction: 0.07 }),
    ]);

    // A window keeps its metric key when the reset of another one passes.
    usage.readings.record(login, { sevenDay: weekly }, now - 6 * 60_000);
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 40, resets_at: resetsAt }, model_scoped: [
      { display_name: "Fable", utilization: 2, resets_at: resetsAt }, { display_name: "Opus", utilization: 7, resets_at: new Date(now - 1000).toISOString() },
    ] } } });
    expect(modelMetric(await usage.read(LOGGED_IN))).toEqual([expect.objectContaining({ metricKey: "seven_day_overage_included:Fable", usedFraction: 0.02 })]);
  });

  test("uses the windows of the account's latest rate-limit report without starting a CLI while the report is recent", async () => {
    const usage = usageFixture();
    const now = Date.now();
    usage.readings.record({ configDir: loginDir(usage.home), accountId: "uuid-person" }, {
      fiveHour: { usedFraction: 1, resetsAtMs: now + 3_600_000 }, sevenDay: { usedFraction: 0.5, resetsAtMs: now - 1_000 },
    }, now - 60_000);

    const outcome = await usage.read(LOGGED_IN);

    // A window whose reset has passed states nothing about the window now.
    expect(outcome).toMatchObject({ kind: "success", report: { observedAtMs: now - 60_000, providerStatus: "exhausted", metrics: [
      { metricKey: "five_hour", usedFraction: 1, timing: { kind: "unavailable", resetAtMs: now + 3_600_000 } },
    ] } });
    expect(outcome.kind === "success" ? outcome.report.metrics : []).toHaveLength(1);
    expect(usage.asked).toEqual([]);

    // Other clients of the account, such as the person's own `claude` installation, spend the same windows without a report
    // here, so an older report gives way to the CLI's reply.
    usage.readings.record({ configDir: loginDir(usage.home), accountId: "uuid-person" }, { fiveHour: { usedFraction: 0.1, resetsAtMs: now + 3_600_000 } }, now - 6 * 60_000);
    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 60, resets_at: null } } } });
    expect(await usage.read(LOGGED_IN)).toMatchObject({ kind: "success", report: { metrics: [{ metricKey: "five_hour", usedFraction: 0.6 }] } });
    expect(usage.asked).toHaveLength(1);
    // Another account's report in the same directory is not this account's reading.
    usage.readings.record({ configDir: loginDir(usage.home), accountId: "uuid-other" }, { fiveHour: { usedFraction: 0.9, resetsAtMs: now + 3_600_000 } }, now);
    expect(await usage.read(LOGGED_IN)).toMatchObject({ kind: "success", report: { metrics: [{ metricKey: "five_hour", usedFraction: 0.6 }] } });
  });

  test("a CLI that holds no login reports an expired sign-in, and a reply it cannot read or a CLI it cannot start fails the read", async () => {
    const usage = usageFixture({ loggedIn: false });
    expect((await usage.read(LOGGED_IN)).kind).toBe("expired-auth");

    usage.answer({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: null } });
    expect((await usage.read(LOGGED_IN)).kind).toBe("fetch-failure");
    usage.answer({ loggedIn: true, reply: "not a reply" });
    expect((await usage.read(LOGGED_IN)).kind).toBe("fetch-failure");
    usage.answer(new Error("the CLI exited"));
    expect((await usage.read(LOGGED_IN)).kind).toBe("fetch-failure");
    // Without the runtime's launch authority no CLI may start.
    usage.answer({ loggedIn: true, reply: { rate_limits_available: false, rate_limits: null } });
    expect((await usage.read(LOGGED_IN, { launcher: false })).kind).toBe("fetch-failure");
  });
});

/** The CLI config of a login whose account is the fixture's account. */
const LOGGED_IN: CliConfig = { oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" }, cachedExtraUsageDisabledReason: null };

/** A process runner that a test with a version reader never reaches. */

/** The provider's external-login definition, with the seams of one test. */
function externalDefinition(seams: ClaudeAgentSdkSeams) {
  const definition = createClaudeAgentSdkModule(seams).contributions[0].value.definition;
  if (!isExternalLoginDefinition(definition)) throw new Error("the provider is not an external login");
  return definition;
}

/** A launcher whose `auth login` leaves the CLI holding `accountUuid` in the fixture's login and exits 0. */
function loginLauncher(home: string, accountUuid: string): LauncherScope {
  return {
    ...refusingLauncher,
    spawnOwned: async () => {
      writeLogin(home, JSON.stringify({ oauthAccount: { accountUuid, emailAddress: "new@example.com" } }));
      const closed = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
      const exit = { code: 0, signal: null, statusOf: "payload", ownership: "surrendered" } as const;
      return { pid: 42, token: "fake", stdin: undefined, stdout: closed(), stderr: closed(), exited: Promise.resolve(exit), terminate: async () => exit };
    },
  };
}

function recoveryFixture() {
  const home = temporaryDirectory("claude-recovery-");
  writeLogin(home, JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
  const observations = createLoginObservations();
  const auth = externalDefinition({ account: () => ({ home, user: "tester" }), observations }).auth;
  const authDir = join(home, ".flywheel", "auth", "profiles", "default");
  const account = auth.accounts(authDir)[0]!;
  observations.recordRequest(account, "login-rejected");
  return { home, observations, auth, authDir, account };
}

/** The provider's usage reader on a home of its own, with a CLI that answers each usage request with `answer` and
 *  starts no process. */
function usageFixture(initial: CliUsage | Error = { loggedIn: true, reply: { rate_limits_available: false, rate_limits: null } }) {
  const home = temporaryDirectory("claude-sdk-usage-");
  const readings = usageReadings();
  const asked: string[] = [];
  /** Each scope that a read opened from the runtime's launch authority: its policy, the CLIs it ran, and whether the
   *  read closed it. */
  const scopes: { readonly policy: unknown; launches: number; closed: boolean }[] = [];
  const opened = new Map<LauncherScope, (typeof scopes)[number]>();
  const launcher: LauncherScope = {
    ...refusingLauncher,
    open: (policy) => {
      const record = { policy, launches: 0, closed: false };
      const scope: LauncherScope = { ...refusingLauncher, close: async () => { record.closed = true; return { settled: true }; } };
      scopes.push(record);
      opened.set(scope, record);
      return scope;
    },
  };
  let answer: CliUsage | Error = initial;
  const [provider] = createClaudeAgentSdkModule({
    account: () => ({ home, user: "tester" }), enginePath: "/scratch/bin/claude", usageReadings: readings, observations: createLoginObservations(),
    readUsage: async (config) => {
      asked.push(config.configDir);
      const record = opened.get(config.launcher);
      if (record !== undefined) record.launches += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }).contributions;
  return {
    home, readings, asked, scopes,
    answer: (next: CliUsage | Error) => { answer = next; },
    read: (config: CliConfig, options: { readonly launcher?: false } = {}) => {
      writeLogin(home, JSON.stringify({ projects: {}, ...config }));
      return provider.value.usageReader({
        providerId: "claude_agent_sdk", authDir: join(home, ".flywheel", "auth", "profiles", "default"), signal: new AbortController().signal,
        account: { instanceId: "uuid-person", identity: "person@example.com", credential: { type: "external", configDir: loginDir(home) } },
        compareAndSetTokens: async () => false,
        ...(options.launcher === false ? {} : { launcher }),
      });
    },
  };
}
