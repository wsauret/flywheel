import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js";
import { captureProviderConnection, type AuthContext } from "../../../../src/infra/auth/auth-context.js";
import type { AccessProviderModelEligibility } from "../../../../src/infra/llm/access-provider.js";
import { getAuthStatusWithDiagnostics } from "../../../../src/orchestration/auth/auth-actions.js";
import { createAuthStatusProjection } from "../../../../src/orchestration/app-service/auth-status-projection.js";
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { installedCredentialProviderIds } from "../../../../src/orchestration/credential-provider-modules.js";

import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../../helpers/auth-context.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
// End-to-end over the provider seams: a [custom_providers] entry becomes a
// composed provider contribution, joins the credential vocabulary, and the
// chain plan admits exactly the right provider for its declared models.

const LOCAL_LLAMA = {
  id: "local_llama",
  displayName: "Local Llama",
  baseUrl: "http://localhost:8080/v1",
  modelIds: new Set(["llama-3.3-70b", "gpt-4o"]),
  catalogId: undefined,
  contextLimit: 128_000,
};

function authWith(overrides: Partial<AuthContext>): AuthContext {
  return {
    providers: authProviders(),
    credentialLineages: {}, droppedCredentials: [],
    ...overrides,
  };
}

const eligibility: AccessProviderModelEligibility = {
  modelUnavailableReason: () => undefined,
  candidateOffering: (candidate, model) => model === "llama-3.3-70b" && candidate.providerId === "local_llama"
    ? { candidate, wireModelId: model, dataUse: "standard", transport: "openai-completions" }
    : model === "gpt-4o"
      ? { candidate, wireModelId: model, dataUse: "standard", transport: candidate.providerId === "local_llama" ? "openai-completions" : "openai-responses" }
      : undefined,
};

const temporaryDirectory = temporaryDirectories();

afterEach(() => {
  installCustomProviders([]);
});

describe("custom provider composition", () => {
  it("declares provider metadata beside its client factory", () => {
    installCustomProviders([LOCAL_LLAMA]);
    const bound = composeFirstPartyModules().contributions.find(
      (contribution) => contribution.domain === "providers" && contribution.id === LOCAL_LLAMA.id,
    );
    if (bound?.domain !== "providers") throw new Error("Missing configured provider");
    expect(bound.value.definition).toMatchObject({
      id: LOCAL_LLAMA.id,
      displayName: LOCAL_LLAMA.displayName,
      billing: "metered",
      spendMode: "direct_api",
      defaultChatTransport: "openai-completions",
      rank: 90,
    });
    expect(bound.value.definition.staticModelUnavailableReason?.("unknown-model")).toBeDefined();
    expect(bound.value.definition.staticModelUnavailableReason?.("llama-3.3-70b")).toBeUndefined();
    expect(typeof bound.value.createClient).toBe("function");
  });

  it("contributes a provider and a factory beside the first-party catalog", () => {
    installCustomProviders([LOCAL_LLAMA]);
    const registry = accessProviderRegistry(composeFirstPartyModules());
    expect(registry.factories.has("local_llama")).toBe(true);
    expect(registry.selection.displayName("local_llama")).toBe("Local Llama");
    expect(registry.selection.billing("local_llama")).toBe("metered");
    expect(registry.selection.catalogId("local_llama")).toBe("local_llama");
  });

  it("joins the live credential vocabulary", () => {
    installCustomProviders([LOCAL_LLAMA]);
    expect(installedCredentialProviderIds()).toContain("local_llama");
    installCustomProviders([]);
    expect(installedCredentialProviderIds()).not.toContain("local_llama");
  });

  it("plans a custom-only model onto exactly the custom provider", () => {
    installCustomProviders([LOCAL_LLAMA]);
    const registry = accessProviderRegistry(composeFirstPartyModules());
    const auth = authWith({
      providers: authProviders({ apiKeys: { openai_api: "sk-first-party", local_llama: "sk-custom" } }),
    });
    const connection = captureProviderConnection({ authDir: "/scratch/unused", auth });
    const plan = registry.selection.plan("llama-3.3-70b", connection, eligibility, false);
    expect(plan.kind).toBe("admitted");
    if (plan.kind === "admitted") {
      expect(plan.family).toBe("openai");
      expect(plan.candidates).toEqual([{ kind: "singleton", providerId: "local_llama", spendMode: "direct_api" }]);
    }
  });

  it("keeps first-party providers ahead of the custom one for shared models", () => {
    installCustomProviders([LOCAL_LLAMA]);
    const registry = accessProviderRegistry(composeFirstPartyModules());
    const auth = authWith({
      providers: authProviders({ apiKeys: { openai_api: "sk-first-party", local_llama: "sk-custom" } }),
    });
    const connection = captureProviderConnection({ authDir: "/scratch/unused", auth });
    const plan = registry.selection.plan("gpt-4o", connection, eligibility, false);
    expect(plan.kind).toBe("admitted");
    if (plan.kind === "admitted") expect(plan.candidates).toEqual([{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, { kind: "singleton", providerId: "local_llama", spendMode: "direct_api" }]);
  });

  it("surfaces valid and rejected entries as auth status rows", () => {
    const accountHome = temporaryDirectory("flywheel-test-custom-provider-status-");
    const authDir = join(accountHome, ".flywheel", "auth");
    mkdirSync(authDir, { recursive: true });
    installCustomProviders([LOCAL_LLAMA], [{ id: "broken", reason: "base_url \"nope\" is not an http(s) URL." }]);
    const rows = getAuthStatusWithDiagnostics(authDir).providers;
    expect(rows.find((row) => row.providerId === "local_llama")?.source).toBe("unconfigured");
    const broken = rows.find((row) => row.source === "misconfigured");
    expect(broken?.source).toBe("misconfigured");
    expect(broken?.providerId).not.toBe("broken");
    expect(broken?.detail).toContain("http(s) URL");
    const profile = { id: "default", persistedId: "default", displayName: "Default", source: "default" as const, directory: authDir, projectBinding: undefined, retirements: {}, availableProfiles: [{ id: "default", displayName: "Default" }] };
    const projection = createAuthStatusProjection({
      initialProfile: profile,
      moduleSelection: () => composeFirstPartyModules(),
      subscriptionSpendConsent: () => ({ kind: "unavailable", profileId: profile.id, message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE }),
    });
    const published = projection.view(profile).providers.find((row) => row.providerId === broken?.providerId);
    expect(published).toMatchObject({ source: "misconfigured", configured: false, displayName: "[custom_providers.broken] (rejected)", detail: expect.stringContaining("http(s) URL") });
  });

  it("refuses a custom model when its key is absent", () => {
    installCustomProviders([LOCAL_LLAMA]);
    const registry = accessProviderRegistry(composeFirstPartyModules());
    const connection = captureProviderConnection({ authDir: "/scratch/unused", auth: authWith({}) });
    const plan = registry.selection.plan("llama-3.3-70b", connection, eligibility, false);
    expect(plan.kind).toBe("unavailable");
    if (plan.kind === "unavailable") expect(plan.reason).toContain("No captured provider catalog");
  });
});
