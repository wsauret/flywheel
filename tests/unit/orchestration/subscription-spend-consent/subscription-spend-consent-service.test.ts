import { afterEach, describe, expect, test } from "bun:test";
import { createSubscriptionAccountIdentity } from "../../../../src/infra/llm/subscription-account-identity.js";
import type { SubscriptionUsageReader } from "../../../../src/infra/llm/subscription-usage.js";
import { createSubscriptionSpendEnvelope } from "../../../../src/infra/auth/subscription-spend-consent.js";
import { SubscriptionSpendConsentStaleError, type SubscriptionSpendConsentSnapshot, type SubscriptionSpendConsentStore } from "../../../../src/infra/auth/subscription-spend-consent-store.js";
import { createSubscriptionSpendConsentService as createService } from "../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js";
import { createSubscriptionUsageService, type SubscriptionUsagePublishedSnapshot } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js";
import { paidModeAwaitsAnswer, subscriptionSpendConsentNeedsReview } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js";
import { createProfileFixture, definition, registry, report, writeAccounts } from "../auth/provider-observations/_service-fixtures.js";

const profiles = createProfileFixture();
afterEach(profiles.cleanup);

const account = { providerId: "chatgpt", instanceId: "account", identity: "person@example.com", label: "Personal" };
const identity = createSubscriptionAccountIdentity(account.providerId, account.instanceId, account.identity);

function usage(spendSources: readonly ({ readonly kind: "prepaid"; readonly availability: "funded" | "available" | "unlimited" | "empty" | "balance-unavailable" | "unknown"; readonly remaining?: { readonly kind: "money"; readonly value: number; readonly currency: string; readonly provenance: "provider"; readonly precision: "exact" } } | { readonly kind: "automatic-billing"; readonly enablement: "enabled" | "disabled" | "unknown" })[], overrides: Partial<SubscriptionUsagePublishedSnapshot> = {}): SubscriptionUsagePublishedSnapshot {
  return {
    generation: 7,
    profileId: "work",
    profileDirectory: "/profiles/work",
    checkedAtMs: 10_000,
    thresholds: Object.freeze([]),
    accounts: Object.freeze([{ kind: "supported", account, snapshot: {
      providerId: account.providerId,
      instanceId: account.instanceId,
      subjectDigest: identity.subjectDigest,
      label: account.label,
      plan: "Plus",
      providerStatus: "ok",
      observedAtMs: 10_000,
      readerGeneration: 1,
      metrics: Object.freeze([]),
      spendSources: Object.freeze([...spendSources]),
    } }]),
    ...overrides,
  };
}

function usageService(snapshot: () => SubscriptionUsagePublishedSnapshot | undefined) {
  return {
    generation: () => ({
      generation: snapshot()?.generation ?? 7,
      profileId: "work",
      profileDirectory: "/profiles/work",
      providerIds: ["chatgpt"],
      enabledModuleIds: [],
      readerProviderIds: ["chatgpt"],
      accounts: [account],
      thresholds: [],
      identity: "auth-generation",
    }),
    snapshot,
  };
}

function createSubscriptionSpendConsentService(options: Omit<Parameters<typeof createService>[0], "paidModes"> & Partial<Pick<Parameters<typeof createService>[0], "paidModes">>) {
  return createService({ paidModes: () => ["prepaid", "automatic"], ...options });
}

interface ConsentDecisions {
  readonly [envelopeId: string]: "accepted" | "declined"
}

function consentStore(decisions: ConsentDecisions = {}): SubscriptionSpendConsentStore {
  return {
    read: async (envelopes): Promise<SubscriptionSpendConsentSnapshot> => ({
      profileId: "work",
      incarnation: "authority-incarnation",
      revision: 3,
      envelopes: envelopes.map((envelope) => ({ envelope, status: decisions[envelope.id] ?? "unreviewed" })),
    }),
    save: async () => { throw new Error("not used"); },
  };
}

describe("subscription spend consent service", () => {
  test("saved decisions alone authorize each exact paid mode without reading usage", async () => {
    const prepaid = createSubscriptionSpendEnvelope("work", identity, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", identity, "automatic");
    const fresh = usage([{ kind: "prepaid", availability: "funded" }, { kind: "automatic-billing", enablement: "enabled" }]);
    const supported = fresh.accounts[0];
    if (supported?.kind !== "supported") throw new Error("expected supported usage fixture");
    for (const snapshot of [
      undefined,
      { ...fresh, accounts: [{ kind: "stale" as const, account, snapshot: supported.snapshot }] },
      { ...fresh, accounts: [{ kind: "failure" as const, account, message: "usage failed" }] },
    ]) {
      for (const decision of ["accepted", "declined", "unreviewed"] as const) {
        let usageReads = 0;
        const service = createSubscriptionSpendConsentService({
          profileId: "work",
          usage: {
            ...usageService(() => snapshot),
            snapshot: () => { usageReads += 1; return snapshot; },
          },
          consent: consentStore(decision === "unreviewed" ? {} : { [prepaid.id]: decision, [automatic.id]: decision }),
        });
        const capture = await service.capture();
        expect(capture.rows.map((row) => row.envelope.id)).toEqual([prepaid.id, automatic.id]);
        expect([...capture.authorizations.keys()]).toEqual(decision === "accepted" ? [prepaid.id, automatic.id] : []);
        expect(usageReads).toBe(0);
      }
    }
  });

  test("derives independent eligible envelopes and joins exact display evidence without persisting it", async () => {
    const prepaid = createSubscriptionSpendEnvelope("work", identity, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", identity, "automatic");
    const source = usage([
      { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" } },
      { kind: "automatic-billing", enablement: "enabled" },
    ]);
    let readEnvelopes = "";
    const store = consentStore({ [prepaid.id]: "accepted", [automatic.id]: "declined" });
    const service = createSubscriptionSpendConsentService({
      profileId: "work",
      usage: usageService(() => source),
      consent: { ...store, read: async (envelopes) => { readEnvelopes = JSON.stringify(envelopes); return store.read(envelopes); } },
      providerPresentation: () => ({ providerDisplayName: "ChatGPT", billingUrl: "https://billing.example/chatgpt" }),
    });

    const capture = await service.capture();

    expect(capture.rows.map((row) => [row.envelope.mode, row.status])).toEqual([["prepaid", "accepted"], ["automatic", "declined"]]);
    expect(capture.rows[0]).toMatchObject({ label: "Personal" });
    const view = await service.view();
    if (view.kind !== "available") throw new Error("expected available consent view");
    expect(view).toMatchObject({ profileId: "work", usageGeneration: 7, authorityIncarnation: "authority-incarnation", authorityRevision: 3 });
    expect(view.accounts).toHaveLength(1);
    expect(view.accounts[0]).toMatchObject({ providerId: "chatgpt", providerDisplayName: "ChatGPT", billingUrl: "https://billing.example/chatgpt", providerStatus: "ok", plan: "Plus", label: "Personal" });
    expect(view.accounts[0]?.modes).toEqual([
      { mode: "prepaid", envelopeId: prepaid.id, evidence: { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" } }, decision: "accepted" },
      { mode: "automatic", envelopeId: automatic.id, evidence: { kind: "automatic-billing", enablement: "enabled" }, decision: "declined" },
    ]);
    expect(readEnvelopes).not.toContain("12.5");
    expect(capture.authorizations.get(prepaid.id)).toMatchObject({ profileId: "work", authorityIncarnation: "authority-incarnation", authorityRevision: 3, account: identity });
    expect(capture.authorizations.has(automatic.id)).toBe(false);
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.rows)).toBe(true);
    expect(Object.isFrozen(capture.authorizations)).toBe(true);
  });

  test("publishes both modes in canonical order and retains decisions when current evidence is unknown", async () => {
    const prepaid = createSubscriptionSpendEnvelope("work", identity, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", identity, "automatic");
    const service = createSubscriptionSpendConsentService({
      profileId: "work",
      usage: usageService(() => usage([])),
      consent: consentStore({ [prepaid.id]: "accepted", [automatic.id]: "declined" }),
    });

    const view = await service.view();

    if (view.kind !== "available") throw new Error("expected available consent view");
    expect(view.accounts[0]?.modes).toEqual([
      { mode: "prepaid", envelopeId: prepaid.id, evidence: { kind: "prepaid", availability: "unknown" }, decision: "accepted" },
      { mode: "automatic", envelopeId: automatic.id, evidence: { kind: "automatic-billing", enablement: "unknown" }, decision: "declined" },
    ]);
  });

  test("shows the last reading's prepaid evidence after it ages and after a failed refresh", async () => {
    const directory = profiles.profile("consent-aged-evidence");
    const definitions = ["aged", "retained"].map(definition);
    writeAccounts(directory, definitions);
    const funded = [{ kind: "prepaid" as const, availability: "funded" as const, remaining: { kind: "money" as const, value: 12.5, currency: "USD", provenance: "provider" as const, precision: "exact" as const } }];
    let now = 10_000;
    const agingUsage = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map<string, SubscriptionUsageReader>([
        ["aged", async () => ({ kind: "success" as const, report: { ...report("aged", 10_000), spendSources: funded } })],
        ["retained", async () => ({ kind: "fetch-failure" as const })],
      ])),
      thresholds: () => [],
      now: () => now,
    });
    agingUsage.store()!.record({ ...report("retained", 9_000), spendSources: funded });
    await agingUsage.check();
    expect(agingUsage.snapshot()?.accounts.map((state) => [state.account.providerId, state.kind])).toEqual([["aged", "supported"], ["retained", "stale"]]);
    now = 10_000 + 5 * 60_000 + 1;
    const service = createService({ profileId: "default", usage: agingUsage, paidModes: () => ["prepaid"], consent: { ...consentStore(), read: async (envelopes) => ({ ...(await consentStore().read(envelopes)), profileId: "default" }) } });

    const view = await service.view();

    if (view.kind !== "available") throw new Error("expected available consent view");
    expect(view.accounts.map((row) => [row.providerId, row.modes.map((mode) => mode.evidence)])).toEqual([
      ["aged", funded],
      ["retained", funded],
    ]);
    agingUsage.closeAdmission();
    await agingUsage.settled();
  });

  test("non-positive evidence never asks an unanswered mode for review", async () => {
    for (const spendSources of [
      [{ kind: "prepaid", availability: "empty" }] as const,
      [{ kind: "prepaid", availability: "balance-unavailable" }] as const,
      [{ kind: "automatic-billing", enablement: "disabled" }] as const,
      [{ kind: "automatic-billing", enablement: "unknown" }] as const,
      [] as const,
    ]) {
      let reads = 0;
      const service = createSubscriptionSpendConsentService({ profileId: "work", usage: usageService(() => usage(spendSources)), consent: { ...consentStore(), read: async (envelopes) => { reads += 1; return consentStore().read(envelopes); } } });
      const capture = await service.capture();
      expect(capture.rows).toHaveLength(2);
      expect(capture.authorizations.size).toBe(0);
      expect(subscriptionSpendConsentNeedsReview(await service.view())).toBe(false);
      expect(reads).toBe(2);
    }

    let reads = 0;
    const failed = createSubscriptionSpendConsentService({ profileId: "work", usage: usageService(() => ({ ...usage([]), accounts: [{ kind: "failure", account, message: "subscription usage request failed" }] })), consent: { ...consentStore(), read: async (envelopes) => { reads += 1; return consentStore().read(envelopes); } } });
    const capture = await failed.capture();
    expect(capture.message).toBeUndefined();
    expect(capture.rows).toHaveLength(2);
    expect(capture.authorizations.size).toBe(0);
    expect(reads).toBe(1);
  });

  test("a sibling with failed usage remains editable without affecting the other account", async () => {
    const funded = usage([{ kind: "prepaid", availability: "funded" }]);
    const partial = { ...funded, accounts: [...funded.accounts, { kind: "failure" as const, account: { providerId: "other", instanceId: "other", identity: "other@example.com" }, message: "usage failed" }] };
    const prepaid = createSubscriptionSpendEnvelope("work", identity, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", identity, "automatic");
    let saveCalls = 0;
    const store = consentStore({ [prepaid.id]: "accepted" });
    const service = createSubscriptionSpendConsentService({
      profileId: "work",
      usage: { ...usageService(() => partial), generation: () => ({ ...usageService(() => partial).generation(), accounts: partial.accounts.map((row) => row.account) }) },
      consent: {
        ...store,
        save: async (mutation) => { saveCalls += 1; return store.read(mutation.envelopes); },
      },
    });

    const capture = await service.capture();
    const view = await service.view();

    expect(capture.rows.map((row) => [row.envelope.providerId, row.envelope.mode, row.status])).toEqual([["chatgpt", "prepaid", "accepted"], ["chatgpt", "automatic", "unreviewed"], ["other", "prepaid", "unreviewed"], ["other", "automatic", "unreviewed"]]);
    expect(capture.message).toBeUndefined();
    expect(capture.authorizations.get(prepaid.id)).toMatchObject({ profileId: "work", authorityIncarnation: "authority-incarnation", authorityRevision: 3 });
    if (view.kind !== "available") throw new Error("expected available consent view");
    expect(view.accounts[0]?.modes.map((mode) => [mode.envelopeId, mode.decision])).toEqual([[prepaid.id, "accepted"], [automatic.id, "unreviewed"]]);

    expect(view.accounts[1]?.modes.every((mode) => !paidModeAwaitsAnswer(mode))).toBe(true);
    const mutation = { profileId: "work", usageGeneration: view.usageGeneration, authorityIncarnation: "authority-incarnation", authorityRevision: 3, clientSnapshotPosition: 0, envelopeIds: capture.rows.map((row) => row.envelope.id) } as const;
    expect(await service.mutate({ ...mutation, type: "subscription_spend_consent.save", reviewedEnvelopeIds: [prepaid.id], acceptedEnvelopeIds: [prepaid.id] })).toMatchObject({ kind: "committed" });
    expect(saveCalls).toBe(1);
  });

  test("failed usage leaves verified auth envelopes available for review", async () => {
    const funded = usage([{ kind: "prepaid", availability: "funded" }]);
    const allFailed = { ...funded, accounts: [{ kind: "failure" as const, account, message: "usage failed" }] };
    let reads = 0;
    const service = createSubscriptionSpendConsentService({ profileId: "work", usage: usageService(() => allFailed), consent: { ...consentStore(), read: async (envelopes) => { reads += 1; return consentStore().read(envelopes); } } });

    const capture = await service.capture();
    const view = await service.view();

    expect(capture.rows).toHaveLength(2);
    expect(capture.message).toBeUndefined();
    expect(capture.authorizations.size).toBe(0);
    expect(view.kind).toBe("available");
    expect(subscriptionSpendConsentNeedsReview(view)).toBe(false);
    expect(reads).toBe(2);
  });

  test("rejects a mutation when usage evidence changes inside the store mutation", async () => {
    const source = usage([{ kind: "prepaid", availability: "funded" }]);
    let published: SubscriptionUsagePublishedSnapshot | undefined = source;
    let decisionsWritten = 0;
    const store = consentStore();
    const service = createSubscriptionSpendConsentService({
      profileId: "work",
      usage: usageService(() => published),
      consent: {
        ...store,
        save: async (mutation) => {
          published = { ...source, generation: source.generation + 1 };
          if (mutation.isEvidenceCurrent?.() === false) throw new SubscriptionSpendConsentStaleError("subscription usage evidence changed");
          decisionsWritten += 1;
          return store.read(mutation.envelopes);
        },
      },
    });
    const view = await service.view();
    if (view.kind !== "available") throw new Error("expected available consent view");
    const envelopeIds = view.accounts.flatMap((accountView) => accountView.modes.map((mode) => mode.envelopeId));

    const result = await service.mutate({ type: "subscription_spend_consent.save", profileId: "work", usageGeneration: view.usageGeneration, authorityIncarnation: view.authorityIncarnation!, authorityRevision: view.authorityRevision!, clientSnapshotPosition: 0, envelopeIds, reviewedEnvelopeIds: [envelopeIds[0]!], acceptedEnvelopeIds: [envelopeIds[0]!] });

    expect(result).toEqual({ kind: "stale" });
    expect(decisionsWritten).toBe(0);
  });

  test("rejects a mutation from an older usage generation before writing consent", async () => {
    let published = usage([{ kind: "prepaid", availability: "funded" }]);
    let saveCalls = 0;
    const store = consentStore();
    const service = createSubscriptionSpendConsentService({
      profileId: "work",
      usage: usageService(() => published),
      consent: {
        ...store,
        save: async (mutation) => {
          saveCalls += 1;
          return store.read(mutation.envelopes);
        },
      },
    });
    const view = await service.view();
    if (view.kind !== "available") throw new Error("expected available consent view");
    const envelopeIds = view.accounts.flatMap((accountView) => accountView.modes.map((mode) => mode.envelopeId));
    published = { ...published, generation: published.generation + 1 };

    const result = await service.mutate({ type: "subscription_spend_consent.save", profileId: "work", usageGeneration: view.usageGeneration, authorityIncarnation: view.authorityIncarnation, authorityRevision: view.authorityRevision, clientSnapshotPosition: 0, envelopeIds, reviewedEnvelopeIds: [envelopeIds[0]!], acceptedEnvelopeIds: [envelopeIds[0]!] });

    expect(result).toEqual({ kind: "stale" });
    expect(saveCalls).toBe(0);
  });

  test("accepts and declines supported modes without evidence", async () => {
    const prepaid = createSubscriptionSpendEnvelope("work", identity, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", identity, "automatic");
    const source = usage([]);
    const saves: string[][] = [];
    const store = consentStore({ [prepaid.id]: "accepted" });
    const service = createSubscriptionSpendConsentService({
      profileId: "work",
      usage: usageService(() => source),
      consent: {
        ...store,
        save: async (mutation) => {
          saves.push([...mutation.acceptedEnvelopeIds]);
          return store.read(mutation.envelopes);
        },
      },
    });
    const view = await service.view();
    if (view.kind !== "available") throw new Error("expected available consent view");
    const mutation = { profileId: "work", usageGeneration: view.usageGeneration, authorityIncarnation: view.authorityIncarnation, authorityRevision: view.authorityRevision, clientSnapshotPosition: 0, envelopeIds: [prepaid.id, automatic.id] } as const;

    expect((await service.capture()).authorizations.size).toBe(1);
    expect(await service.mutate({ ...mutation, type: "subscription_spend_consent.save", reviewedEnvelopeIds: [prepaid.id], acceptedEnvelopeIds: [prepaid.id] })).toMatchObject({ kind: "committed" });
    expect(await service.mutate({ ...mutation, type: "subscription_spend_consent.save", reviewedEnvelopeIds: [prepaid.id], acceptedEnvelopeIds: [] })).toMatchObject({ kind: "committed" });
    expect(await service.mutate({ ...mutation, type: "subscription_spend_consent.save", reviewedEnvelopeIds: [prepaid.id, automatic.id], acceptedEnvelopeIds: [prepaid.id, automatic.id] })).toMatchObject({ kind: "committed" });
    expect(saves).toEqual([[prepaid.id], [], [prepaid.id, automatic.id]]);
  });

  test("derives envelopes only for verified auth identities and declared paid modes", async () => {
    const funded = usage([{ kind: "prepaid", availability: "available" }]);
    const supported = funded.accounts[0];
    if (supported?.kind !== "supported") throw new Error("expected supported usage fixture");

    const service = usageService(() => funded);
    const missingIdentity = await createSubscriptionSpendConsentService({ profileId: "work", usage: { ...service, generation: () => ({ ...service.generation(), accounts: [{ ...account, identity: undefined }] }) }, consent: consentStore() }).capture();
    expect(missingIdentity.rows).toEqual([]);
    const mode = await createSubscriptionSpendConsentService({ profileId: "work", usage: service, paidModes: () => ["prepaid"], consent: consentStore() }).view();
    if (mode.kind !== "available") throw new Error("expected available view");
    expect(mode.accounts[0]?.modes.map((row) => row.mode)).toEqual(["prepaid"]);
    expect(subscriptionSpendConsentNeedsReview(mode)).toBe(true);
    const wrongProfile = await createSubscriptionSpendConsentService({ profileId: "other", usage: service, consent: consentStore() }).capture();
    expect(wrongProfile.authorizations.size).toBe(0);
    expect(wrongProfile.message).toBe("Flywheel could not read this profile's paid-use settings. Paid use is off until it can.");
  });
});
