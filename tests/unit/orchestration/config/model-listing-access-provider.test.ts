import { describe, it, expect } from "bun:test";
import { AUTH_DIR, AUTH_NONE } from "./_model-listing-fixtures.js";
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js";
import type { AccessProviderCandidate, AccessProviderModelEligibility } from "../../../../src/infra/llm/access-provider.js";
import { testProviderSelection } from "../../../helpers/provider-authority.js";
import { authProviders } from "../../../helpers/auth-context.js";

// ---------------------------------------------------------------------------
// Access provider — family chains and model compatibility
// ---------------------------------------------------------------------------

const AUTH_EVERYTHING = {
  providers: authProviders({ apiKeys: { anthropic_api: "[redacted secret]", openai_api: "[redacted secret]", google_api: "[redacted secret]" }, oauth: ["github_copilot", "chatgpt"] }),
  credentialLineages: {}, droppedCredentials: [],
};

type ExactOffering = { readonly wireModelId: string; readonly transport: "anthropic-messages" | "openai-responses" | "openai-completions" | "google" };
function exactEligibility(offerings: ReadonlyMap<string, ReadonlyMap<string, ExactOffering>>): AccessProviderModelEligibility {
  return {
    modelUnavailableReason: (provider, model) => offerings.get(provider)?.has(model) ? undefined : `${provider} does not offer "${model}"`,
    candidateOffering: (candidate: AccessProviderCandidate, model) => {
      const offering = offerings.get(candidate.providerId)?.get(model);
      return offering === undefined ? undefined : { candidate, dataUse: "standard", ...offering };
    },
  };
}

it("exposes definition-owned provider presentation metadata", () => {
  const selection = testProviderSelection();
  expect(selection.displayName("chatgpt")).toBe("ChatGPT Subscription");
  expect(selection.billingUrl("chatgpt")).toBe("https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform");
  expect(selection.billingUrl("anthropic_api")).toBeUndefined();
  expect(selection.billingUrl("uninstalled_provider")).toBeUndefined();
});

describe("access provider family chains", () => {
  it("orders the openai chain ChatGPT, Copilot, OpenAI API", async () => {
    expect(testProviderSelection().getConfiguredForFamily("openai", AUTH_EVERYTHING)).toEqual([
      "chatgpt",
      "github_copilot",
      "openai_api",
    ]);
  });

  it("orders the anthropic chain Copilot, Anthropic API", async () => {
    expect(testProviderSelection().getConfiguredForFamily("anthropic", AUTH_EVERYTHING)).toEqual([
      "github_copilot",
      "anthropic_api",
    ]);
  });

  it("puts the Copilot subscription ahead of the Google API key for google models", async () => {
    expect(testProviderSelection().getConfiguredForFamily("google", AUTH_EVERYTHING)).toEqual([
      "github_copilot",
      "google_api",
    ]);
  });

  it("keeps chain order independent of which credentials exist", async () => {
    const providers = testProviderSelection().getConfiguredForFamily("openai", {
      ...AUTH_EVERYTHING,
      providers: authProviders({ base: AUTH_EVERYTHING.providers, without: ["github_copilot"] }),
    });
    expect(providers).toEqual(["chatgpt", "openai_api"]);
  });

  it("appends OpenRouter to the openai chain when its key is configured", async () => {
    const providers = testProviderSelection().getConfiguredForFamily("openai", {
      ...AUTH_EVERYTHING,
      providers: authProviders({ base: AUTH_EVERYTHING.providers, apiKeys: { openrouter: "openrouter-test-key" } }),
    });
    expect(providers).toEqual(["chatgpt", "github_copilot", "openai_api", "openrouter"]);
  });

  it("plans exact eligible offerings in provider order and preserves wire relationships", () => {
    const auth = {
      ...AUTH_NONE,
      providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { openai_api: "openai", openrouter: "router" } }),
    };
    const connection = captureProviderConnection({ authDir: AUTH_DIR, auth });
    const eligibility = exactEligibility(new Map([
      ["openai_api", new Map<string, ExactOffering>([["gpt-5.4", { wireModelId: "gpt-5.4-2026-03-01", transport: "openai-responses" }]])],
      ["openrouter", new Map<string, ExactOffering>([["gpt-5.4", { wireModelId: "openai/gpt-5.4", transport: "openai-completions" }]])],
    ]));
    const plan = testProviderSelection().plan("gpt-5.4", connection, eligibility);
    expect(plan.kind).toBe("admitted");
    if (plan.kind !== "admitted") throw new Error("expected admitted plan");
    expect(plan.candidates.map((candidate) => candidate.providerId)).toEqual(["openai_api", "openrouter"]);
    expect(plan.candidateAttributions.map(({ wireModelId, transport }) => ({ wireModelId, transport }))).toEqual([
      { wireModelId: "gpt-5.4-2026-03-01", transport: "openai-responses" },
      { wireModelId: "openai/gpt-5.4", transport: "openai-completions" },
    ]);
  });
});
