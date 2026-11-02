import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js";
import { createSubscriptionAccountIdentity } from "../../../../src/infra/llm/subscription-account-identity.js";
import { createSubscriptionSpendEnvelope } from "../../../../src/infra/auth/subscription-spend-consent.js";
import { createSubscriptionSpendConsentStore, subscriptionSpendConsentRevision, SubscriptionSpendConsentCorruptError, SubscriptionSpendConsentStaleError } from "../../../../src/infra/auth/subscription-spend-consent-store.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

/** The accounts that the profile holds now, which a test changes between a read and a save. */
function accountsNow(...subjects: readonly string[]) {
  const holder = { accounts: subjects.map((subject, index) => createSubscriptionAccountIdentity("chatgpt", `instance-${String.fromCharCode(97 + index)}`, subject)) };
  return { holder, currentAccounts: () => holder.accounts };
}

describe("subscription spend consent store", () => {
  test("shares canonical account identity with usage and keeps raw subjects out of durable identity", () => {
    const first = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a");
    const refreshed = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a");
    const replacement = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-b");
    expect(first).toEqual(refreshed);
    expect(first.subjectDigest).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("account-a");
    expect(replacement).not.toEqual(first);
  });

  test("derives unreviewed from absence and round-trips accepted and declined", async () => {
    const root = temporaryDirectory("subscription-consent-unit-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts: accountsNow("account-a").currentAccounts });
    const account = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a");
    const prepaid = createSubscriptionSpendEnvelope("work", account, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", account, "automatic");

    const initial = await store.read([prepaid, automatic]);
    expect(initial.revision).toBe(0);
    expect(initial.incarnation).toMatch(/^[0-9a-f-]{36}$/);
    expect(initial.envelopes.map(({ status }) => status)).toEqual(["unreviewed", "unreviewed"]);

    const saved = await store.save({
      expectedIncarnation: initial.incarnation,
      expectedRevision: initial.revision,
      envelopes: [prepaid, automatic],
      reviewedEnvelopeIds: [prepaid.id, automatic.id],
      acceptedEnvelopeIds: [prepaid.id],
    });
    expect(saved.revision).toBe(1);
    expect(saved.envelopes.map(({ status }) => status)).toEqual(["accepted", "declined"]);
    expect(access.readFile("subscription-spend-consent-v1.sqlite", 1024 * 1024)?.toString("utf8")).not.toContain("account-a");
    access.close();
  });

  test("updates only explicit reviewed envelopes", async () => {
    const root = temporaryDirectory("subscription-consent-partial-unit-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts: accountsNow("account-a").currentAccounts });
    const account = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a");
    const prepaid = createSubscriptionSpendEnvelope("work", account, "prepaid");
    const automatic = createSubscriptionSpendEnvelope("work", account, "automatic");
    const initial = await store.read([prepaid, automatic]);
    const accepted = await store.save({ expectedIncarnation: initial.incarnation, expectedRevision: initial.revision, envelopes: [prepaid, automatic], reviewedEnvelopeIds: [automatic.id], acceptedEnvelopeIds: [automatic.id] });
    const partial = await store.save({ expectedIncarnation: accepted.incarnation, expectedRevision: accepted.revision, envelopes: [prepaid, automatic], reviewedEnvelopeIds: [prepaid.id], acceptedEnvelopeIds: [] });
    expect(partial.envelopes.map(({ status }) => status)).toEqual(["declined", "accepted"]);
    access.close();
  });


  test("preserves decisions for temporarily absent unchanged envelopes", async () => {
    const root = temporaryDirectory("subscription-consent-retained-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    expect(subscriptionSpendConsentRevision(access)).toEqual({ kind: "missing" });

    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts: accountsNow("account-a", "account-b").currentAccounts });
    const firstAccount = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a");
    const acceptedEnvelope = createSubscriptionSpendEnvelope("work", firstAccount, "prepaid");
    const declinedEnvelope = createSubscriptionSpendEnvelope("work", firstAccount, "automatic");
    const otherEnvelope = createSubscriptionSpendEnvelope("work", createSubscriptionAccountIdentity("chatgpt", "instance-b", "account-b"), "prepaid");
    const initial = await store.read([acceptedEnvelope, declinedEnvelope]);
    const reviewed = await store.save({ expectedIncarnation: initial.incarnation, expectedRevision: initial.revision, envelopes: [acceptedEnvelope, declinedEnvelope], reviewedEnvelopeIds: [acceptedEnvelope.id, declinedEnvelope.id], acceptedEnvelopeIds: [acceptedEnvelope.id] });
    const savedOther = await store.save({ expectedIncarnation: reviewed.incarnation, expectedRevision: reviewed.revision, envelopes: [otherEnvelope], reviewedEnvelopeIds: [otherEnvelope.id], acceptedEnvelopeIds: [] });

    expect(savedOther.envelopes).toEqual([{ envelope: otherEnvelope, status: "declined" }]);
    expect((await store.read([acceptedEnvelope, declinedEnvelope])).envelopes.map(({ status }) => status)).toEqual(["accepted", "declined"]);
    const revision = subscriptionSpendConsentRevision(access);
    expect(revision.kind).toBe("content");
    if (revision.kind === "content") expect(revision.digest).toMatch(/^[a-f0-9]{64}$/);
    access.close();
  });

  test("rejects a stored decision whose owned envelope fields do not match", async () => {
    const root = temporaryDirectory("subscription-consent-corrupt-row-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts: accountsNow("account-a").currentAccounts });
    const account = createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a");
    const prepaid = createSubscriptionSpendEnvelope("work", account, "prepaid");
    const initial = await store.read([prepaid]);
    await store.save({ expectedIncarnation: initial.incarnation, expectedRevision: 0, envelopes: [prepaid], reviewedEnvelopeIds: [prepaid.id], acceptedEnvelopeIds: [prepaid.id] });

    const encoded = access.readFile("subscription-spend-consent-v1.sqlite", 1024 * 1024);
    if (encoded === undefined) throw new Error("consent database was not persisted");
    const db = Database.deserialize(Buffer.from(encoded.toString("utf8"), "base64"));
    db.query("update decisions set provider_id = 'anthropic' where envelope_id = ?").run(prepaid.id);
    access.writeFile("subscription-spend-consent-v1.sqlite", Buffer.from(db.serialize()).toString("base64"));
    db.close();

    await expect(store.read([prepaid])).rejects.toBeInstanceOf(SubscriptionSpendConsentCorruptError);
    access.close();
  });
});

describe("profile-local subscription spend consent coordination", () => {
  test("serializes writers and rejects a stale revision without losing the winner", async () => {
    const root = temporaryDirectory("subscription-consent-coordination-");
    const profiles = new AuthProfileStore(root);
    const firstAccess = await profiles.create("work", "Work");
    const secondAccess = await profiles.open("work");
    if (secondAccess === undefined) throw new Error("work profile was not found");
    const { currentAccounts } = accountsNow("account-a");
    const first = createSubscriptionSpendConsentStore({ profileId: "work", access: firstAccess, currentAccounts });
    const second = createSubscriptionSpendConsentStore({ profileId: "work", access: secondAccess, currentAccounts });
    const envelope = createSubscriptionSpendEnvelope("work", createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a"), "prepaid");
    const initial = await first.read([envelope]);

    const outcomes = await Promise.allSettled([
      first.save({ expectedIncarnation: initial.incarnation, expectedRevision: 0, envelopes: [envelope], reviewedEnvelopeIds: [envelope.id], acceptedEnvelopeIds: [envelope.id] }),
      second.save({ expectedIncarnation: initial.incarnation, expectedRevision: 0, envelopes: [envelope], reviewedEnvelopeIds: [envelope.id], acceptedEnvelopeIds: [] }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find(({ status }) => status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(SubscriptionSpendConsentStaleError);
    expect((await first.read([envelope])).revision).toBe(1);
    firstAccess.close();
    secondAccess.close();
  });

  test("saves a decision for a current account that auth.json does not hold, such as an external login's", async () => {
    const root = temporaryDirectory("subscription-consent-external-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const account = createSubscriptionAccountIdentity("claude_agent_sdk", "uuid-person", "person@example.com");
    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts: () => [account] });
    const envelope = createSubscriptionSpendEnvelope("work", account, "automatic");
    const initial = await store.read([envelope]);

    const saved = await store.save({ expectedIncarnation: initial.incarnation, expectedRevision: initial.revision, envelopes: [envelope], reviewedEnvelopeIds: [envelope.id], acceptedEnvelopeIds: [] });

    expect(saved.envelopes).toEqual([{ envelope, status: "declined" }]);
    access.close();
  });

  test("rejects account replacement atomically and preserves incarnation and revision", async () => {
    const root = temporaryDirectory("subscription-consent-stale-account-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const { holder, currentAccounts } = accountsNow("account-a");
    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts });
    const envelope = createSubscriptionSpendEnvelope("work", createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a"), "automatic");
    const initial = await store.read([envelope]);
    holder.accounts = accountsNow("account-b").holder.accounts;

    await expect(store.save({ expectedIncarnation: initial.incarnation, expectedRevision: initial.revision, envelopes: [envelope], reviewedEnvelopeIds: [envelope.id], acceptedEnvelopeIds: [envelope.id] })).rejects.toBeInstanceOf(SubscriptionSpendConsentStaleError);
    const replacement = createSubscriptionSpendEnvelope("work", createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-b"), "automatic");
    const after = await store.read([replacement]);
    expect({ incarnation: after.incarnation, revision: after.revision, status: after.envelopes[0]?.status }).toEqual({ incarnation: initial.incarnation, revision: 0, status: "unreviewed" });
    access.close();
  });

  test("revalidates usage evidence under the profile writer lock before writing", async () => {
    const root = temporaryDirectory("subscription-consent-evidence-fence-");
    const access = await new AuthProfileStore(root).create("work", "Work");
    const store = createSubscriptionSpendConsentStore({ profileId: "work", access, currentAccounts: accountsNow("account-a").currentAccounts });
    const envelope = createSubscriptionSpendEnvelope("work", createSubscriptionAccountIdentity("chatgpt", "instance-a", "account-a"), "prepaid");
    const initial = await store.read([envelope]);
    let checks = 0;

    await expect(store.save({ expectedIncarnation: initial.incarnation, expectedRevision: initial.revision, envelopes: [envelope], reviewedEnvelopeIds: [envelope.id], acceptedEnvelopeIds: [envelope.id], isEvidenceCurrent: () => { checks += 1; return false; } })).rejects.toBeInstanceOf(SubscriptionSpendConsentStaleError);

    const after = await store.read([envelope]);
    expect(checks).toBe(1);
    expect({ revision: after.revision, status: after.envelopes[0]?.status }).toEqual({ revision: 0, status: "unreviewed" });
    access.close();
  });
});
