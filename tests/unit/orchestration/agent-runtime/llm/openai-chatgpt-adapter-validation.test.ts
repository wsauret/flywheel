import { describe, it, expect } from "bun:test";
import { Redacted } from "effect";

import { captureProviderConnection, type AuthContext, type SubscriptionCredentials } from "../../../../../src/infra/auth/auth-context.js";
import { testEligibility, testProviderRegistry } from "../../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { resolveCapturedRole } from "../../../../../src/orchestration/config/models/role-resolution.js";

describe("role resolution through captured ChatGPT auth", () => {

  const capture = (auth: AuthContext, subscriptionCredentials: SubscriptionCredentials = new Map(), providerId?: string) => ({
    connection: captureProviderConnection({ profileId: "default", authDir: "/scratch/flywheel-chatgpt-validation/auth", auth, subscriptionCredentials }),
    providers: testProviderRegistry(),
    eligibility: testEligibility({
      modelIds: new Set(["gpt-6.1-sol"]),
      candidateOfferings: (candidate: import("../../../../../src/infra/llm/access-provider.js").AccessProviderCandidate, model: string) =>
        candidate.providerId === providerId
          ? [{ candidate, wireModelId: model, dataUse: "standard" as const, transport: "openai-responses" as const }]
          : [],
    }),
    runtimeConfig: testRuntimeConfigCapture(),
    admit: () => { throw new Error("Validation tests do not admit clients"); },
  });
  const auth = (values: Partial<AuthContext>): AuthContext => ({
    providers: authProviders(),
    credentialLineages: {}, droppedCredentials: [],
    ...values,
  });

  it("accepts a captured ChatGPT subscription for an OpenAI model", async () => {
    const profileAuth = auth({ providers: authProviders({ oauth: ["chatgpt"] }),});
    const subscriptions = new Map([["chatgpt", [{
      instanceId: "chatgpt-test",
      credential: { type: "oauth" as const, access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: Date.now() + 60_000 },
    }]]]);
    const captured = capture(profileAuth, subscriptions, "chatgpt");
    const result = await resolveCapturedRole("chat", {}, { selection: captured.providers.selection, ...captured, allowTrainingRoutes: false }, "/scratch");
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") throw new Error("Expected the subscription model");
    expect(result.role.model).toBe("gpt-6.1-sol");
    expect(result.plan.candidates[0]?.providerId).toBe("chatgpt");
  });

  it("returns no selection without a provider", async () => {
    const captured = capture(auth({}));
    expect(await resolveCapturedRole("chat", {}, { selection: captured.providers.selection, ...captured, allowTrainingRoutes: false }, "/scratch")).toEqual({ kind: "no-selection" });
  });

  it("keeps an unavailable saved Anthropic model as the role's unserved seat, whose agent waits for it (PI-MODEL-087)", async () => {
    const subscriptions = new Map([["chatgpt", [{ instanceId: "chatgpt-test", credential: { type: "oauth" as const, access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: Date.now() + 60_000 } }]]]);
    const captured = capture(auth({ providers: authProviders({ oauth: ["chatgpt"] }) }), subscriptions, "chatgpt");
    const result = await resolveCapturedRole("chat", { model: "claude-opus-5.5", effort: "low" }, { selection: captured.providers.selection, ...captured, allowTrainingRoutes: false }, "/scratch");
    expect(result).toMatchObject({ kind: "unserved", role: { model: "claude-opus-5.5", effort: "low" } });
  });
});
