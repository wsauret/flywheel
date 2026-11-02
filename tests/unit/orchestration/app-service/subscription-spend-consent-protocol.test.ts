import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { createUsageAppService as createFlywheelAppService } from "../../../helpers/usage-app-service.js";
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js";
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js";
import { FrontendMutationSchema, RuntimeUiPatchSchema } from "../../../../src/protocol/runtime-protocol-schemas.js";
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js";
import { createInertSubscriptionUsageService } from "../../../helpers/subscription-usage-service-fixture.js";
import { subscriptionSpendConsentEnvelopeIds, subscriptionSpendConsentNeedsReview } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js";

const consent = {
  kind: "available",
  profileId: "work",
  usageGeneration: 7,
  authorityIncarnation: "authority-1",
  authorityRevision: 4,
  accounts: [{ accountCorrelationId: "opaque-account", providerId: "anthropic", providerDisplayName: "Anthropic", providerStatus: "ok", modes: [
    { mode: "prepaid", envelopeId: "opaque-prepaid-envelope", evidence: { kind: "prepaid", availability: "available" }, decision: "unreviewed" },
    { mode: "automatic", envelopeId: "opaque-automatic-envelope", evidence: { kind: "automatic-billing", enablement: "unknown" }, decision: "accepted" },
  ] }],
} as const;

describe("subscription spend consent protocol", () => {
  test("auth snapshots carry one secret-free consent view", () => {
    const patch = { cursor: { scope: "workspace", domain: "auth" }, position: 8, prevPosition: 7, payload: { kind: "auth.changed", auth: { providers: [], warnings: [], profile: { id: "work", displayName: "Work", source: "default", availableProfiles: [] }, subscriptionSpendConsent: consent } } } as const;
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch);
    expect(JSON.stringify(patch)).not.toContain("subjectDigest");
    expect(JSON.stringify(patch)).not.toContain("credential");
  });

  test("uses canonical envelope order and reviews only positive unreviewed evidence", () => {
    expect(subscriptionSpendConsentEnvelopeIds(consent)).toEqual(["opaque-prepaid-envelope", "opaque-automatic-envelope"]);
    expect(subscriptionSpendConsentNeedsReview(consent)).toBe(true);
    expect(subscriptionSpendConsentNeedsReview({ ...consent, accounts: consent.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => ({ ...mode, evidence: mode.mode === "prepaid" ? { kind: "prepaid" as const, availability: "unknown" as const } : mode.evidence })) })) })).toBe(false);
  });

  test("rejects impossible available and unavailable consent variants", () => {
    const decode = Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" });
    const auth = { providers: [], warnings: [], profile: { id: "work", displayName: "Work", source: "default", availableProfiles: [] } } as const;
    const patch = (subscriptionSpendConsent: unknown) => ({ cursor: { scope: "workspace", domain: "auth" }, position: 8, prevPosition: 7, payload: { kind: "auth.changed", auth: { ...auth, subscriptionSpendConsent } } });

    expect(() => decode(patch({ kind: "available", profileId: "work", rows: [] }))).toThrow();
    expect(() => decode(patch({ ...consent, reviewComplete: false }))).toThrow();
    expect(() => decode(patch({ kind: "unavailable", profileId: "work", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can.", rows: [] }))).toThrow();
    expect(() => decode(patch({ kind: "unavailable", profileId: "work", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can.", authorityRevision: 1 }))).toThrow();
    expect(() => decode(patch({ ...consent, warning: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." }))).toThrow();
  });

  test("consent writes carry auth cursor and authority correlation", () => {
    const mutation = { type: "subscription_spend_consent.save", profileId: "work", usageGeneration: 3, authorityIncarnation: "authority-1", authorityRevision: 4, clientSnapshotPosition: 8, envelopeIds: ["opaque-prepaid-envelope", "opaque-automatic-envelope"], reviewedEnvelopeIds: ["opaque-prepaid-envelope"], acceptedEnvelopeIds: ["opaque-prepaid-envelope"] } as const;
    expect(Schema.decodeUnknownSync(FrontendMutationSchema)(mutation)).toEqual(mutation);
    expect(() => Schema.decodeUnknownSync(FrontendMutationSchema)({ ...mutation, usageGeneration: undefined })).toThrow();
    expect(() => Schema.decodeUnknownSync(FrontendMutationSchema)({ type: "subscription_spend_consent.keep_off", profileId: "work", usageGeneration: 3, authorityIncarnation: "authority-1", authorityRevision: 4, clientSnapshotPosition: 8, envelopeIds: ["opaque-prepaid-envelope"] })).toThrow();
  });

  test("oauth settlement is correlated to its exact operation and account", () => {
    const patch = { cursor: { scope: "workspace", domain: "auth" }, position: 9, prevPosition: 8, payload: { kind: "auth.changed", auth: { providers: [], warnings: [], profile: { id: "work", displayName: "Work", source: "default", availableProfiles: [] }, subscriptionSpendConsent: consent, settlement: { kind: "completed", operationId: "oauth-operation", providerId: "anthropic" } } } } as const;
    expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch);
  });

  test("usage open publishes consent before it returns", async () => {
    const sessionStore = fakeSessionStore(new Map());
    const manager = fakeManager();
    const projections = fakeProjections();
    const events: string[] = [];
    const usage = createInertSubscriptionUsageService({ onCheck: () => { events.push("usage"); } });
    const deps = {
      projection: createFrontendProjection({ sessionStore, manager, projectRoot: "/scratch" }),
      projectRoot: "/scratch",
      runtimeSupervisor: runtimeSupervisor(),
      bus: createRuntimeUiBus(),
      subscriptionUsage: {
        acquireScope: async () => ({ profile: { id: "default", directory: "/scratch" }, service: usage, release: async () => {} }),
        subscribePublications: () => () => {},
      },
      refreshSubscriptionSpendConsent: async () => { events.push("consent"); },
      ...projections,
    } satisfies Parameters<typeof createFlywheelAppService>[0];
    const service = createFlywheelAppService(deps);

    expect(await service.dispatch({ type: "usage.open", scope: { kind: "defaults" }, freshnessMs: 0 })).toMatchObject({ ok: true });
    expect(events).toEqual(["usage", "consent"]);
  });

  test("auth cursor advancement does not invalidate a current consent mutation", async () => {
    const sessionStore = fakeSessionStore(new Map());
    const manager = fakeManager();
    const projections = fakeProjections();
    const bus = createRuntimeUiBus();
    let mutationCalls = 0;
    const deps = {
      projection: createFrontendProjection({ sessionStore, manager, projectRoot: "/scratch" }),
      projectRoot: "/scratch",
      runtimeSupervisor: runtimeSupervisor(),
      bus,
      subscriptionSpendConsent: {
        mutate: async () => {
          mutationCalls += 1;
          return { kind: "committed", consent };
        },
      },
      ...projections,
    } satisfies Parameters<typeof createFlywheelAppService>[0];
    const service = createFlywheelAppService(deps);
    bus.publish({ cursor: { scope: "workspace", domain: "auth" }, payload: { kind: "auth.changed", auth: { providers: [], warnings: [], profile: { id: "work", displayName: "Work", source: "default", availableProfiles: [] }, subscriptionSpendConsent: consent } } });

    const result = await service.dispatch({ type: "subscription_spend_consent.save", profileId: "work", usageGeneration: consent.usageGeneration, authorityIncarnation: "authority-1", authorityRevision: 4, clientSnapshotPosition: 0, envelopeIds: ["opaque-prepaid-envelope", "opaque-automatic-envelope"], reviewedEnvelopeIds: ["opaque-prepaid-envelope"], acceptedEnvelopeIds: ["opaque-prepaid-envelope"] });

    expect(result).toEqual({ kind: "committed", consent });
    expect(mutationCalls).toBe(1);
  });
});
