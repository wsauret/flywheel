/**
 * The standalone benchmark CLI's provider admission. It admits its matrix
 * through the same capture-and-plan contract the embedded tool uses: one
 * capture for preflight. Unreachable settings fall through without constructing
 * a provider client.
 *
 * No test here may build a provider client: every admitted factory throws.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../../bench/ab-persona/bench.js";
import { captureProviderConnection, type AuthContext } from "../../../src/infra/auth/auth-context.js";
import type { FailoverPlan } from "../../../src/infra/llm/access-provider.js";
import type { UsageAuthorityGeneration } from "../../../src/orchestration/agent-runtime/usage-settlement.js";
import { admitBenchmark } from "../../../src/orchestration/modules/development/benchmark/admission.js";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import type { RunConfig } from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import { createPersonaStore } from "../../../src/orchestration/modules/development/benchmark/persona-store.js";
import type { WorkflowDeps } from "../../../src/orchestration/workflow-host/deps.js";
import { createBackgroundExecutionOwner } from "../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js";
import { createForegroundBashHoldController } from "../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { testDirectories } from "../../helpers/directories.js";
import { testProviderRegistry } from "../../helpers/provider-authority.js";
import { roleCapture } from "../../helpers/role-capture.js";
import { testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";
import { authProviders } from "../../helpers/auth-context.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { refusingLauncher } from "../../helpers/launcher-fake.js";
import { makeWorkflowDeps } from "../orchestration/headless/_headless-run-fixtures.js";

const { userDataRoot, accountHome } = testDirectories(process.cwd());

/** Only the OpenAI API key is configured, so an Anthropic-only seat is served
 *  by no configured provider. */
const AUTH: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: "[redacted secret]" } }),
  credentialLineages: {}, droppedCredentials: [],
};

interface AdmissionSpy {
  captures: number;
  admitted: ReadonlyMap<string, FailoverPlan> | null;
  clientBuilds: number;
  disposals: number;
}

function fakeRuntime(usageAuthority: UsageAuthorityGeneration = { profileId: "default", authorityIncarnation: "test" }) {
  const spy: AdmissionSpy = { captures: 0, admitted: null, clientBuilds: 0, disposals: 0 };
  const eligibility = roleCapture(["gpt-6-luna", "gpt-6.1-sol"]).eligibility;
  const deps: WorkflowDeps = {
    ...makeWorkflowDeps(),
    userDataRoot,
    accountHome,
    moduleSelection: composeFirstPartyModules,
    definitions: repoDefinitions(),
    runOwnedCommand: () => { throw new Error("no command may be launched in this test"); },
    captureProviderConnection: async () => {
      spy.captures++;
      return {
        providers: testProviderRegistry(),
        connection: captureProviderConnection({ profileId: usageAuthority.profileId, authDir: join(userDataRoot, "auth"), auth: AUTH }),
        runtimeConfig: testRuntimeConfigCapture(),
        eligibility,
        requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async () => ({ kind: "serves" as const }), admit: (plans: ReadonlyMap<string, FailoverPlan>) => {
          spy.admitted = plans;
          return {
            createAgent: () => { throw new Error("no benchmark cell may run in this test"); },
            createLLMClient: () => {
              spy.clientBuilds++;
              throw new Error("no provider client may be built in this test");
            },
          };
        },
      };
    },
  };
  const launcher = refusingLauncher;
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
  const foregroundBashHold = createForegroundBashHoldController(() => {});
  return {
    create: async () => ({
      deps,
      profileId: usageAuthority.profileId,
      usageAuthority,
      background,
      foregroundBashHold,
      launcher,
      shell: background.shell,
      runOwnedCommand: deps.runOwnedCommand,
      assertUsageAuthority: () => {},
      [Symbol.asyncDispose]: async () => {
        await background.close();
        await foregroundBashHold.awaitSettlement();
        foregroundBashHold.dispose();
        spy.disposals++;
      },
    }),
    spy,
  };
}

describe("standalone benchmark admission", () => {
  it("retains serving policy across catalog revisions, route changes, and role settings", async () => {
    const runtime = await fakeRuntime().create();
    try {
      const capture = await runtime.deps.captureProviderConnection();
      const seats = [{ role: "candidate", model: "gpt-6-luna" }] as const;
      const identity = async (revision: number, wireSuffix = "", omitReasoning = false) => {
        const base = roleCapture(["gpt-6-luna", "gpt-6.1-sol"]).eligibility;
        if (!base) throw new Error("The catalog fixture requires eligibility");
        const admission = await admitBenchmark({
          ...runtime.deps,
          captureProviderConnection: async () => ({
            ...capture,
            eligibility: {
              ...base, revision,
              candidateOffering: (candidate, model, policy) => {
                const offering = base.candidateOffering?.(candidate, model, policy);
                return offering ? {
                  ...offering, wireModelId: `${offering.wireModelId}${wireSuffix}`,
                  ...(omitReasoning && offering.resolvedModelMetadata ? {
                    resolvedModelMetadata: { ...offering.resolvedModelMetadata, cost: { ...offering.resolvedModelMetadata.cost, reasoning: undefined } },
                  } : {}),
                } : undefined;
              },
            },
          }),
        }, seats);
        return admission.runtime.admissionIdentity?.runtimeConfig;
      };
      expect(await identity(1)).toBe(await identity(2));
      expect(await identity(2, "-different-route")).toBe(await identity(2));
      expect(await identity(2, "", true)).toBe(await identity(2));
      const roleIdentity = async (model: string) => (await admitBenchmark({
        ...runtime.deps,
        captureProviderConnection: async () => ({ ...capture, runtimeConfig: { ...capture.runtimeConfig, profileRoles: { advisor: { model } } } }),
      }, seats)).runtime.admissionIdentity?.runtimeConfig;
      expect(await roleIdentity("model-a")).toBe(await roleIdentity("model-b"));
      const policyIdentity = async (allowTrainingRoutes: boolean) => (await admitBenchmark({
        ...runtime.deps,
        captureProviderConnection: async () => ({ ...capture, runtimeConfig: { ...capture.runtimeConfig, allowTrainingRoutes } }),
      }, seats)).runtime.admissionIdentity?.runtimeConfig;
      expect(await policyIdentity(true)).not.toBe(await policyIdentity(false));
    } finally {
      await runtime[Symbol.asyncDispose]();
    }
  });
  it("preflights unavailable authored settings through the role defaults without building a client", async () => {
    const { create, spy } = fakeRuntime();
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
    try {
      await main(
        ["--persona", "explorer", "--variant", "lost-model:medium", "--variant", "gpt-6-luna:xhigh", "--dry-run"],
        create,
      );
    } finally { log.mockRestore(); }

    expect(spy.captures).toBe(1);
    expect(spy.admitted?.has("gpt-6-luna")).toBe(true);
    expect(JSON.parse(output[0] ?? "{}").providerPlans).toMatchObject([
      { role: "candidate", model: "gpt-6-luna", effort: "high" },
      { role: "candidate", model: "gpt-6-luna", effort: "high" },
      { role: "judge", model: "gpt-6.1-sol", effort: "high" },
    ]);
    expect(spy.clientBuilds).toBe(0);
    expect(spy.disposals).toBe(1);
  });

  it("shows a pinned judge and its provider in the dry run, and names the candidate settings that share its model", async () => {
    const { create, spy } = fakeRuntime();
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => { output.push(String(value)); });
    try {
      await main(["--persona", "explorer", "--variant", "gpt-6-luna:high", "--variant", "gpt-6-luna:xhigh", "--judge", "gpt-6.1-sol:low", "--dry-run"], create);
      await main(["--persona", "explorer", "--variant", "gpt-6-luna:high", "--variant", "gpt-6.1-sol:xhigh", "--judge", "gpt-6.1-sol:xhigh", "--dry-run"], create);
    } finally { log.mockRestore(); }

    const [distinct, shared] = output.map((text) => JSON.parse(text));
    expect(distinct.providerPlans.find((plan: { role: string }) => plan.role === "judge"))
      .toEqual({ role: "judge", model: "gpt-6.1-sol", effort: "low", profileId: "default", providers: ["openai_api"] });
    expect(distinct.judgeModelCandidates).toEqual([]);
    // The settings are the resolved ones; this test profile serves every candidate at high effort.
    expect(shared.judgeModelCandidates).toEqual(["gpt-6.1-sol:high"]);
    expect(output).toHaveLength(2);
    expect(spy.clientBuilds).toBe(0);
  });

  it("admits a resumed campaign through the selected current profile, not the stored generation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-standalone-benchmark-"));
    const catalog = createBenchmarkCatalog(projectRoot);
    await mkdir(catalog.personaDefinitionsDir, { recursive: true });
    await Bun.write(join(catalog.personaDefinitionsDir, "explorer.md"), await Bun.file(join(process.cwd(), "src", "workflows", "agents", "personas", "explorer.md")).text());
    const resultsDir = join(catalog.resultsRoot, "stored-run");
    const identity = {
      profileId: "stored-profile",
      authorityIncarnation: "stored-incarnation",
      contentIdentity: "0".repeat(64),
    };
    const config: RunConfig = {
      kind: "benchmark-config",
      persona: "explorer",
      mode: "research",
      variants: [
        { id: "gpt-6-astra@medium", model: "gpt-6-astra", effort: "medium" },
        { id: "gpt-6-luna@xhigh", model: "gpt-6-luna", effort: "xhigh" },
      ],
      repeats: 1,
      stamp: "stored-run",
      identity,
      taskIdentity: "task",
      personaGuidanceIdentity: "persona",
      judgeIdentity: "judge",
      scoringVersion: "persona-v2",
    };
    await mkdir(catalog.resultsRoot, { recursive: true });
    await createPersonaStore({ resultsRoot: catalog.resultsRoot, directory: resultsDir }, config, catalog.researchTasks("explorer").map(({ id }) => id));
    const { create } = fakeRuntime(identity);
    let requestedGeneration: UsageAuthorityGeneration | undefined;
    const log = spyOn(console, "log").mockImplementation(() => {});

    try {
      await main(["--resume", resultsDir, "--auth-profile", "current-profile", "--dry-run"], async (root, stored, profile) => {
        expect(root).toBe(projectRoot);
        expect(profile).toBe("current-profile");
        requestedGeneration = stored;
        return await create();
      }, projectRoot);
    } finally {
      log.mockRestore();
      await rm(projectRoot, { recursive: true, force: true });
    }

    expect(requestedGeneration).toBeUndefined();
  });
});
