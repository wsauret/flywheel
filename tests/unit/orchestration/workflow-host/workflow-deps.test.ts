import { captureModuleRequestSections } from "../../../../src/orchestration/agent-runtime/request-config.js";
import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { Redacted } from "effect";
import { bindWorkflowDepsToSession, prepareWorkflowDeps } from "../../../../src/orchestration/workflow-host/deps";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../../../../src/orchestration/config/schema";
import type { AgentFactory, AgentOptions } from "../../../../src/orchestration/agent-runtime/types";
import type { PrepareWorkflowDepsInput, WorkflowDepsOverrides } from "../../../../src/orchestration/workflow-host/deps";
import { repoDefinitions } from "../../../helpers/project-definitions.js";
import type { AccountDirectories } from "../../../../src/infra/directory-authorities.js";
import { testDirectories } from "../../../helpers/directories.js";
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js";
import { testCapabilityModules } from "../../../helpers/provider-authority.js";
import { authProviders } from "../../../helpers/auth-context.js";

/** Account authorities of the isolated test account home. A case that reads the
 *  global config publishes its own instead. */
const ACCOUNT: AccountDirectories = testDirectories(process.cwd());
const NO_AUTH = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    ...CONFIG_DEFAULTS,
    ...overrides,
  };
}

function makeFakeRunnerFactory(): AgentFactory {
  return () => ({
    send: () => {},
    end: () => {},
    abort: () => {},
    done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }),
  });
}

function makeOverrides(): WorkflowDepsOverrides {
  return {
    createAgent: makeFakeRunnerFactory(),
    availableModels: new Map(),
    connection: captureProviderConnection({
      profileId: "default",
      authDir: join(ACCOUNT.userDataRoot, "auth"),
      auth: { ...NO_AUTH },
      oauthPersistence: "memory-only",
    }),
  };
}

function depsInput(overrides: WorkflowDepsOverrides, account: AccountDirectories = ACCOUNT, config = makeConfig()): PrepareWorkflowDepsInput {
  return {
    onNotification: () => {},
    accountHome: account.accountHome,
    userDataRoot: account.userDataRoot,
    definitions: repoDefinitions(),
    moduleSelection: testCapabilityModules(),
    resolveKey: async () => undefined,
    awaitModelAccessSettled: async () => {},
    captureRuntimeConfig: () => ({
      revision: 1,
      profileId: "work",
      foregroundBashHoldSeconds: config.foreground_bash_hold_seconds,
      webSearchProvider: config.web_search.provider,
      proactiveCompactionThreshold: config.proactive_compaction_threshold,
      idleCompaction: config.idle_compaction,
      cacheRetentionPolicies: config.cache_retention,
      providerSettings: {},
      allowTrainingRoutes: false,
      allowPersistentProcesses: config.allow_persistent_processes,
      profileRoles: config.profiles.work?.roles ?? {},
      gitAiAttribution: config.profiles.work?.git_ai_attribution ?? false,
      budget: config.budget,
      workflow: config.workflow,
      moduleSections: captureModuleRequestSections(config),
    }),
    overrides,
  };
}

// ---------------------------------------------------------------------------
// prepareWorkflowDeps
// ---------------------------------------------------------------------------

describe("prepareWorkflowDeps", () => {

  it("returns an agent runner factory without mutable config or refresh state", async () => {
    const deps = await prepareWorkflowDeps(depsInput(makeOverrides()));

    expect(deps.createAgent).toBeDefined();
    expect("config" in deps).toBe(false);
    expect("refresh" in deps).toBe(false);
  });

  it("does not infer model families from subscription catalog names", async () => {
    const auth = { ...NO_AUTH };
    const connection = captureProviderConnection({
      profileId: "default",
      authDir: join(ACCOUNT.userDataRoot, "auth"),
      auth,
      oauthPersistence: "memory-only",
    });
    const deps = await prepareWorkflowDeps(depsInput({
      ...makeOverrides(),
      connection,
      availableModels: new Map([["anthropic", new Set(["claude-sonnet-4-6"])]]),
    }));

    expect(deps.availableModels).toEqual(new Map([["anthropic", new Set(["claude-sonnet-4-6"])]]));
  });

  it("keeps an injected auth snapshot pinned", async () => {
    const auth = { ...NO_AUTH };
    const connection = captureProviderConnection({ profileId: "default", authDir: join(ACCOUNT.userDataRoot, "auth"), auth, oauthPersistence: "memory-only" });
    const deps = await prepareWorkflowDeps(depsInput({ ...makeOverrides(), connection }));

    expect(deps.auth).toBe(auth);
  });

  it("does not consult live profile providers for an access-only snapshot", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls += 1; throw new Error("live profile provider must not be reached"); }, { preconnect: () => {} });
    const auth = { ...NO_AUTH, providers: authProviders({ base: NO_AUTH.providers, oauth: ["chatgpt"] }),};
    const connection = captureProviderConnection({
      profileId: "default",
      authDir: join(ACCOUNT.userDataRoot, "auth"),
      auth,
      subscriptionCredentials: new Map([["chatgpt", [{ instanceId: "snapshot", credential: { type: "oauth", access: Redacted.make("snapshot-access"), refresh: Redacted.make("snapshot-refresh"), expires: 1, accountId: "snapshot" } }]]]),
      oauthPersistence: "access-only",
    });
    try {
      const deps = await prepareWorkflowDeps(depsInput({ ...makeOverrides(), connection }));
      expect(deps.availableModels.size).toBe(0);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("captures the profile directory and id before provider preparation", async () => {
    let profile = "work"
    let profileReads = 0
    let directoryReads = 0
    const deps = await prepareWorkflowDeps({
      ...depsInput(makeOverrides()),
      authDirectory: () => {
        directoryReads += 1
        return join(ACCOUNT.userDataRoot, "auth", profile)
      },
      activeProfileId: () => {
        profileReads += 1
        return profile
      },
    })

    profile = "personal"
    expect(deps.activeProfileId).toBe("work")
    expect(deps.activeProfileId).toBe("work")
    expect(profileReads).toBe(1)
    expect(directoryReads).toBe(1)
  })

  it("propagates profile-specific request captures through workflow dependencies", async () => {
    let profileId = "work"
    const config = makeConfig({
      profiles: {
        work: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { github_copilot: { monthly_credit_cap: 1200 } } },
        personal: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { github_copilot: { monthly_credit_cap: 0 } } },
      },
    })
    const input = depsInput(makeOverrides(), ACCOUNT, config)
    const captureBase = input.captureRuntimeConfig
    const deps = await prepareWorkflowDeps({
      ...input,
      captureRuntimeConfig: () => ({
        ...captureBase(),
        profileId,
        providerSettings: config.profiles[profileId]?.providers ?? {},
      }),
    })

    expect(deps.captureRuntimeConfig()).toMatchObject({ profileId: "work", providerSettings: { github_copilot: { monthly_credit_cap: 1200 } } })
    profileId = "personal"
    expect(deps.captureRuntimeConfig()).toMatchObject({ profileId: "personal", providerSettings: { github_copilot: { monthly_credit_cap: 0 } } })
  })

  it("captures the latest complete session runtime for each provider request", async () => {
    let admittedOptions: AgentOptions | undefined
    const createAgent: AgentFactory = (options) => {
      admittedOptions = options
      return makeFakeRunnerFactory()(options)
    }
    const first = await prepareWorkflowDeps(depsInput({ ...makeOverrides(), createAgent }))
    const second = await prepareWorkflowDeps(depsInput({ ...makeOverrides(), createAgent }))
    let current = first
    let captures = 0
    const live = bindWorkflowDepsToSession(first, {
      capture: async () => {
        captures += 1
        return current
      },
      current: () => current,
    })

    live.createAgent({
      model: "gpt-6.1-sol",
      purpose: { kind: "interactive-chat" },
      ...ACCOUNT,
      projectRoot: process.cwd(),
      executionCwd: process.cwd(),
      onEvent: () => {},
      conversation: { kind: "stateless" },
      lifecycle: { kind: "one-shot" },
    })
    const captureModelRuntime = admittedOptions?.captureModelRuntime
    if (!captureModelRuntime) throw new Error("session-bound agent requires request-time model admission")

    const firstCapture = await captureModelRuntime()
    current = second
    const secondCapture = await captureModelRuntime()
    await live.captureProviderConnection()

    expect(firstCapture.generation).toBe(first)
    expect(secondCapture.generation).toBe(second)
    expect(captures).toBe(3)
  })
});
