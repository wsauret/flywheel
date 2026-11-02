import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeAuthProfile } from "../../../../../src/infra/auth/auth-profile-normalization.js";
import { AuthProfileStore, openExistingAuthProfileDirectory } from "../../../../../src/infra/auth/auth-profile-store.js";
import { loadAuthStoreWithDiagnostics } from "../../../../../src/infra/auth/auth-store.js";
import { readProviderModelPreferences } from "../../../../../src/infra/auth/provider-model-preference-store.js";
import { createSubscriptionSpendEnvelope } from "../../../../../src/infra/auth/subscription-spend-consent.js";
import { createSubscriptionSpendConsentStore } from "../../../../../src/infra/auth/subscription-spend-consent-store.js";
import { createSubscriptionAccountIdentity } from "../../../../../src/infra/llm/subscription-account-identity.js";
import { Log } from "../../../../../src/infra/log.js";
import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { composeFirstPartyModules, type FirstPartyModule } from "../../../../../src/orchestration/modules.js";
import { createClaudeAgentSdkModule } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { usageReadings } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/account-usage.js";
import { createSubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js";
import { createSubscriptionSpendConsentService } from "../../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js";
import { createSubscriptionSpendConsentNotificationMaterializer } from "../../../../../src/orchestration/subscription-spend-consent/notification-materializer.js";
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../../../../src/infra/notification-episode.js";
import { refusingLauncher } from "../../../../helpers/launcher-fake.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { LOGIN_ACCOUNTS_DIRECTORY, LOGIN_PROGRAM_LABEL } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();

/** The CLI's global config fields beside `oauthAccount` that a test sets. */
interface GlobalConfigExtra {
  readonly cachedExtraUsageDisabledReason?: string | null;
}

/** Writes a Claude login of the profile in `authDir`, as the CLI does after Flywheel's login button, and returns its
 *  config directory. */
function writeProfileLogin(authDir: string, oauthAccount: unknown, extra: GlobalConfigExtra = {}): string {
  const configDir = join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "a");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount, ...extra }));
  return configDir;
}

/** A home whose own `claude` is logged in, which no profile uses, and the `claude-sdk` profile that the Agent SDK
 *  prototype's setup wrote: each login stored as an `api_key` instance whose key is its config directory. */
async function prototypeProfile(instances: readonly { readonly id: string; readonly credential: unknown }[]) {
  const home = temporaryDirectory("auth-normalization-");
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
  const modules: readonly FirstPartyModule[] = [createClaudeAgentSdkModule({ account: () => ({ home, user: "tester" }), enginePath: "/scratch/bin/claude" })];
  // Normalization reads every installed definition, also of a module that is off.
  const composition = composeFirstPartyModules(modules, []);
  const access = await new AuthProfileStore(join(home, ".flywheel")).create("claude-sdk");
  access.writeFile("auth.json", JSON.stringify({
    claude_agent_sdk: instances.map(({ id, credential }, index) => ({ id, identity: id, lineageId: `00000000-0000-4000-8000-00000000000${index}`, credential })),
  }));
  const directory = access.authDirectory;
  access.close();
  return {
    home,
    directory,
    classifySlot: credentialSlotClassifier(composition),
    definitions: accessProviderRegistry(composition).selection.definitions,
  };
}

describe("the Agent SDK provider's profile conversions", () => {
  // Remove with the conversion after 2027-04-08.
  test("removes the prototype's stored Claude logins, and warns once for each directory whose account must be added again", async () => {
    const elsewhere = "/scratch/old-claude-config";
    const warn = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn");
    try {
      const profile = await prototypeProfile([]);
      const found = writeProfileLogin(profile.directory, { accountUuid: "uuid-work", emailAddress: "work@example.com" });
      // The prototype stored the CLI's default directory, which belongs to the person's own `claude` installation and no profile uses.
      const defaultDir = join(profile.home, ".claude");
      writeFileSync(join(profile.directory, "auth.json"), JSON.stringify({
        claude_agent_sdk: [
          { id: "found", identity: found, lineageId: "00000000-0000-4000-8000-000000000001", credential: { type: "api_key", key: found } },
          { id: "default", identity: defaultDir, lineageId: "00000000-0000-4000-8000-000000000002", credential: { type: "api_key", key: defaultDir } },
          { id: "lost", identity: elsewhere, lineageId: "00000000-0000-4000-8000-000000000003", credential: { type: "api_key", key: elsewhere } },
        ],
      }));

      expect(await normalizeAuthProfile(profile.directory, profile.classifySlot, ["claude_agent_sdk"], profile.definitions)).toBe("normalized");

      expect(loadAuthStoreWithDiagnostics(profile.directory, ["claude_agent_sdk"], profile.classifySlot, false).store.claude_agent_sdk).toBeUndefined();
      expect(warn.mock.calls).toEqual([
        ["a stored Claude login directory is no longer used, so its account must be added again from Authentication", { configDir: defaultDir }],
        ["a stored Claude login directory is no longer used, so its account must be added again from Authentication", { configDir: elsewhere }],
      ]);
      const definition = profile.definitions.find(({ id }) => id === "claude_agent_sdk");
      expect(definition?.auth.kind === "external" ? definition.auth.accounts(profile.directory).map(({ accountId }) => accountId) : undefined).toEqual(["uuid-work"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps a stored Claude credential of a shape the conversion does not know, and says so", async () => {
    const warn = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn");
    try {
      const profile = await prototypeProfile([{ id: "token", credential: { type: "oauth", access: "opaque", expires: 2_000_000_000_000 } }]);

      await normalizeAuthProfile(profile.directory, profile.classifySlot, ["claude_agent_sdk"], profile.definitions);

      expect(loadAuthStoreWithDiagnostics(profile.directory, ["claude_agent_sdk"], profile.classifySlot, false).store.claude_agent_sdk).toBeDefined();
      expect(warn.mock.calls).toEqual([["a stored Claude login has a shape that the conversion does not know, so it is kept"]]);
    } finally {
      warn.mockRestore();
    }
  });

  // Remove with the conversion after 2027-04-08.
  describe("the earlier native Anthropic Subscription provider", () => {
    const L = (n: number) => `00000000-0000-4000-8000-00000000001${n}`;
    const oauth = (accountId?: string) => ({ type: "oauth", access: "sk-ant-oat01-secret-access", refresh: "sk-ant-ort01-secret-refresh", expires: 2_000_000_000_000, ...(accountId === undefined ? {} : { accountId }) });
    const subscription = (providerId: string, instanceId: string) => ({ kind: "subscription" as const, providerId, instanceId });

    /** A profile that the native provider wrote: its OAuth instances in auth.json beside another provider's key,
     *  model choices keyed by each native instance, and an accepted paid-use decision for the first instance. */
    async function nativeProfile(instances: readonly { readonly id: string; readonly identity: string; readonly accountId?: string }[]) {
      const profile = await prototypeProfile([]);
      writeFileSync(join(profile.directory, "auth.json"), JSON.stringify({
        claude_subscription: instances.map(({ id, identity, accountId }, index) => ({ id, identity, lineageId: L(index), credential: oauth(accountId) })),
        openai_api: { type: "api_key", key: "sk-openai", lineageId: L(9) },
      }));
      writeFileSync(join(profile.directory, "model-preferences.json"), JSON.stringify({
        version: 4,
        accounts: instances.map(({ id }) => ({ account: subscription("claude_subscription", id), disabled: ["claude-haiku-4.5"] })),
      }));
      const first = instances[0];
      if (first !== undefined) {
        const account = createSubscriptionAccountIdentity("claude_subscription", first.id, first.identity);
        const access = openExistingAuthProfileDirectory(profile.directory);
        try {
          const consent = createSubscriptionSpendConsentStore({ profileId: "claude-sdk", access, currentAccounts: () => [account] });
          const envelope = createSubscriptionSpendEnvelope("claude-sdk", account, "prepaid");
          const read = await consent.read([envelope]);
          await consent.save({ expectedIncarnation: read.incarnation, expectedRevision: read.revision, envelopes: [envelope], reviewedEnvelopeIds: [envelope.id], acceptedEnvelopeIds: [envelope.id] });
        } finally {
          access.close();
        }
      }
      return profile;
    }

    async function normalize(profile: Awaited<ReturnType<typeof prototypeProfile>>, notify?: (occurrence: NotificationOccurrence) => void) {
      return normalizeAuthProfile(profile.directory, profile.classifySlot, ["claude_agent_sdk", "openai_api"], profile.definitions, notify);
    }

    function preferenceAccounts(directory: string) {
      const access = openExistingAuthProfileDirectory(directory);
      try {
        return [...readProviderModelPreferences(access, new Map()).accounts.values()].map(({ account, disabled }) => [account, [...disabled]]);
      } finally {
        access.close();
      }
    }

    test("deletes the stored Claude tokens, moves each account's choices to its account id, and tells the person once to log in for Flywheel, though the person's own `claude` is logged in", async () => {
      const warn = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn");
      const info = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "info");
      try {
        const profile = await nativeProfile([
          { id: "native-person", identity: "person@example.com", accountId: "uuid-person" },
          { id: "native-other", identity: "other@example.com", accountId: "uuid-other" },
        ]);
        const notices: NotificationOccurrence[] = [];

        expect(await normalize(profile, (occurrence) => { notices.push(occurrence); })).toBe("normalized");

        const stored = JSON.parse(readFileSync(join(profile.directory, "auth.json"), "utf8"));
        expect(Object.keys(stored)).toEqual(["openai_api"]);
        expect(stored.openai_api).toEqual({ type: "api_key", key: "sk-openai", lineageId: L(9) });
        expect(preferenceAccounts(profile.directory)).toEqual([
          [subscription("claude_agent_sdk", "uuid-other"), ["claude-haiku-4.5"]],
          [subscription("claude_agent_sdk", "uuid-person"), ["claude-haiku-4.5"]],
        ]);
        const access = openExistingAuthProfileDirectory(profile.directory);
        try {
          const envelope = createSubscriptionSpendEnvelope("claude-sdk", createSubscriptionAccountIdentity("claude_agent_sdk", "uuid-person", "person@example.com"), "prepaid");
          expect((await createSubscriptionSpendConsentStore({ profileId: "claude-sdk", access, currentAccounts: () => [] }).read([envelope])).envelopes.map(({ status }) => status)).toEqual(["accepted"]);
        } finally {
          access.close();
        }
        // Each account keeps its choices under its account id until it logs in. The person's own `claude` login of the same
        // account is no login of the profile.
        expect(warn.mock.calls).toEqual([
          ["a Claude account of the earlier native Anthropic Subscription provider has no Claude login in this profile; log in to it from Authentication", { identity: "person@example.com" }],
          ["a Claude account of the earlier native Anthropic Subscription provider has no Claude login in this profile; log in to it from Authentication", { identity: "other@example.com" }],
        ]);
        expect(JSON.stringify([...warn.mock.calls, ...info.mock.calls])).not.toContain("sk-ant");
        expect(notices).toEqual([expect.objectContaining({
          title: "Claude accounts need a login",
          message: `The Anthropic Subscription provider now keeps a Claude login of its own in each profile and no longer uses the ${LOGIN_PROGRAM_LABEL} login. Log in to person@example.com and other@example.com from Authentication to use them again.`,
          severity: "warning", action: { kind: "open-auth-provider", providerId: "claude_agent_sdk" },
        })]);
        expect(JSON.stringify(notices)).not.toContain("sk-ant");
        // The person reads it once: a later start finds nothing left to convert.
        expect(await normalize(profile, (occurrence) => { notices.push(occurrence); })).toBe("normalized");
        expect(notices).toHaveLength(1);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });

    test("a run that cannot tell the person, such as a headless run, leaves an account without a login for a run that can, so the notice is never lost", async () => {
      const profile = await nativeProfile([
        { id: "native-person", identity: "person@example.com", accountId: "uuid-person" },
        { id: "native-other", identity: "other@example.com", accountId: "uuid-other" },
      ]);
      const before = readFileSync(join(profile.directory, "auth.json"), "utf8");

      // That run reads the profile's credentials and changes none, because the store does not know the retired entry.
      expect(await normalize(profile)).toBe("read-only");
      expect(readFileSync(join(profile.directory, "auth.json"), "utf8")).toBe(before);
      const notices: NotificationOccurrence[] = [];
      expect(await normalize(profile, (occurrence) => { notices.push(occurrence); })).toBe("normalized");
      expect(Object.keys(JSON.parse(readFileSync(join(profile.directory, "auth.json"), "utf8")))).toEqual(["openai_api"]);
      expect(notices.map(({ title }) => title)).toEqual(["Claude accounts need a login"]);
    });

    test("a paid-use decision that the person declined for a native account keeps paid use off for the account's Flywheel login, and the question does not return", async () => {
      const home = temporaryDirectory("auth-declined-");
      const composition = composeFirstPartyModules([createClaudeAgentSdkModule({
        account: () => ({ home, user: "tester" }), enginePath: "/scratch/bin/claude", usageReadings: usageReadings(),
        readUsage: async () => ({ loggedIn: true, reply: { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: null } } } }),
      })], []);
      const registry = accessProviderRegistry(composition);
      const access = await new AuthProfileStore(join(home, ".flywheel")).create("claude-sdk");
      // The person logged in for Flywheel, and the CLI records that extra usage can bill the account, so paid use is a
      // choice that the person can make.
      writeProfileLogin(access.authDirectory, { accountUuid: "uuid-person", emailAddress: "person@example.com" }, { cachedExtraUsageDisabledReason: null });
      access.writeFile("auth.json", JSON.stringify({ claude_subscription: [{ id: "native-person", identity: "person@example.com", lineageId: L(0), credential: oauth("uuid-person") }] }));
      const native = createSubscriptionAccountIdentity("claude_subscription", "native-person", "person@example.com");
      const consent = createSubscriptionSpendConsentStore({ profileId: "claude-sdk", access, currentAccounts: () => [native] });
      const declined = createSubscriptionSpendEnvelope("claude-sdk", native, "automatic");
      const before = await consent.read([declined]);
      await consent.save({ expectedIncarnation: before.incarnation, expectedRevision: before.revision, envelopes: [declined], reviewedEnvelopeIds: [declined.id], acceptedEnvelopeIds: [] });
      const directory = access.authDirectory;
      access.close();

      expect(await normalizeAuthProfile(directory, credentialSlotClassifier(composition), ["claude_agent_sdk"], registry.selection.definitions)).toBe("normalized");

      const usage = createSubscriptionUsageService({ profile: () => ({ id: "claude-sdk", directory }), registry: () => registry, thresholds: () => [], launcher: refusingLauncher });
      const reopened = openExistingAuthProfileDirectory(directory);
      try {
        await usage.check();
        const service = createSubscriptionSpendConsentService({ profileId: "claude-sdk", usage, paidModes: () => ["automatic"], consent: createSubscriptionSpendConsentStore({ profileId: "claude-sdk", access: reopened, currentAccounts: usage.currentAccounts }) });
        const capture = await service.capture();
        const automatic = capture.rows.find(({ envelope }) => envelope.mode === "automatic");
        expect(automatic).toMatchObject({ envelope: { providerId: "claude_agent_sdk", instanceId: "uuid-person" }, status: "declined" });
        expect(await service.view()).toMatchObject({ accounts: [{ modes: [{ evidence: { kind: "automatic-billing", enablement: "enabled" } }] }] });
        // The walk admits the account's paid route only with an authorization, and a declined decision grants none.
        expect(capture.authorizations.size).toBe(0);
        const episodes: NotificationEpisodeInput[] = [];
        const materializer = createSubscriptionSpendConsentNotificationMaterializer({ notify: async (episode) => { episodes.push(episode); } });
        await materializer.materialize(await service.view());
        expect(episodes).toMatchObject([{ type: "reconcile", desired: [] }]);
      } finally {
        reopened.close();
        usage.closeAdmission();
        await usage.settled();
      }
    });

    test("matches a stored account with no account id by its email to a login of the profile, and names an account that matches no login", async () => {
      const warn = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn");
      try {
        const profile = await nativeProfile([
          { id: "native-person", identity: "person@example.com" },
          { id: "native-lost", identity: "lost@example.com" },
        ]);
        // An earlier build added this login to the profile with its Add account button.
        writeProfileLogin(profile.directory, { accountUuid: "uuid-person", emailAddress: "person@example.com" });
        const notices: NotificationOccurrence[] = [];

        expect(await normalize(profile, (occurrence) => { notices.push(occurrence); })).toBe("normalized");

        expect(Object.keys(JSON.parse(readFileSync(join(profile.directory, "auth.json"), "utf8")))).toEqual(["openai_api"]);
        const accounts = preferenceAccounts(profile.directory).map(([account]) => account);
        expect(accounts).toContainEqual(subscription("claude_agent_sdk", "uuid-person"));
        expect(accounts).not.toContainEqual(subscription("claude_subscription", "native-person"));
        expect(warn.mock.calls).toEqual([["a Claude account of the earlier native Anthropic Subscription provider has no Claude account id and no Claude login in this profile, so its saved choices stay behind; log in to it from Authentication", { identity: "lost@example.com" }]]);
        expect(notices.map(({ title, message }) => [title, message])).toEqual([["A Claude account needs a login", `The Anthropic Subscription provider now keeps a Claude login of its own in each profile and no longer uses the ${LOGIN_PROGRAM_LABEL} login. Log in to lost@example.com from Authentication to use it again.`]]);
      } finally {
        warn.mockRestore();
      }
    });

    test("keeps the stored Claude tokens when the saved choices cannot move, so the next start tries again", async () => {
      const warn = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn");
      try {
        const profile = await nativeProfile([{ id: "native-person", identity: "person@example.com", accountId: "uuid-person" }]);
        writeProfileLogin(profile.directory, { accountUuid: "uuid-person", emailAddress: "person@example.com" });
        const preferences = readFileSync(join(profile.directory, "model-preferences.json"));
        writeFileSync(join(profile.directory, "model-preferences.json"), "{ not json");

        await normalize(profile);

        expect(Object.keys(JSON.parse(readFileSync(join(profile.directory, "auth.json"), "utf8")))).toEqual(["claude_subscription", "openai_api"]);
        expect(warn.mock.calls.map(([message]) => message)).toEqual(["the model choices of the earlier native Anthropic Subscription provider could not be moved, so its stored sign-in stays until the next start tries again"]);

        writeFileSync(join(profile.directory, "model-preferences.json"), preferences);
        expect(await normalize(profile)).toBe("normalized");

        expect(Object.keys(JSON.parse(readFileSync(join(profile.directory, "auth.json"), "utf8")))).toEqual(["openai_api"]);
        expect(preferenceAccounts(profile.directory)).toEqual([[subscription("claude_agent_sdk", "uuid-person"), ["claude-haiku-4.5"]]]);
      } finally {
        warn.mockRestore();
      }
    });

    test("keeps a stored entry of the earlier native Anthropic Subscription provider of a shape the conversion does not know, and says so", async () => {
      const warn = spyOn(Log.create({ service: "provider-claude-agent-sdk" }), "warn");
      try {
        const profile = await prototypeProfile([]);
        const bytes = JSON.stringify({ claude_subscription: { type: "api_key", key: "unknown-shape" } });
        writeFileSync(join(profile.directory, "auth.json"), bytes);

        await normalize(profile);

        expect(readFileSync(join(profile.directory, "auth.json"), "utf8")).toBe(bytes);
        expect(warn.mock.calls).toEqual([["a stored credential of the earlier native Anthropic Subscription provider has a shape that the conversion does not know, so it is kept"]]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
