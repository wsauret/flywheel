import { Result, Schema } from "effect";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AuthProfileAccess } from "../../../infra/auth/auth-profile-store.js";
import { AUTH_STORE_FILE, loadAuthStoreWithDiagnostics } from "../../../infra/auth/auth-store.js";
import { deleteProviderCredentials } from "../../../infra/auth/auth-store-mutations.js";
import { CredentialInstanceSchema, isCredentialCollection, type CredentialInstance, type OAuthCredential } from "../../../infra/auth/auth-store-types.js";
import { transferProviderModelPreferences } from "../../../infra/auth/provider-model-preference-store.js";
import { transferSubscriptionSpendDecisions } from "../../../infra/auth/subscription-spend-consent-store.js";
import { errorMessage } from "../../../infra/error-message.js";
import type { AccessProviderAccountIdentity, AuthProfileConversion, ExternalAccount } from "../../../infra/llm/access-provider.js";
import { Log } from "../../../infra/log.js";
import type { NotificationOccurrence } from "../../../infra/notification-episode.js";
import { isRecord, type UnknownRecord } from "../../../infra/record.js";
import { CLAUDE_AGENT_SDK_LABEL, CLAUDE_AGENT_SDK_PROVIDER_ID, LOGIN_PROGRAM_LABEL } from "./names.js";

const log = Log.create({ service: "provider-claude-agent-sdk" });

/**
 * Converts the logins that the Agent SDK bridge prototype stored (`flywheel claude-sdk setup`, source runs only):
 * each Claude CLI login was an `api_key` instance whose value was its config directory. The CLI owns the login now
 * and Flywheel stores nothing, so the conversion removes the entry. A login in a directory that discovery finds
 * needs no action. For a login in any other directory, one warning names the directory and tells the person to add
 * the account again. An entry that holds any other shape is not this one: a warning says so and the bytes stay.
 * Remove this conversion and its test after 2027-04-08, by which time every source-run home has converted.
 */
export function prototypeLoginConversion(accounts: (authDir: string) => readonly ExternalAccount[]): AuthProfileConversion {
  return {
    phase: "after-decode",
    convert: async ({ access, classifySlot, installedIds }) => {
      const stored = loadAuthStoreWithDiagnostics(access.authDirectory, installedIds, classifySlot, false).store[CLAUDE_AGENT_SDK_PROVIDER_ID];
      if (stored === undefined) return;
      const credentials = isCredentialCollection(stored) ? stored.map(({ credential }) => credential) : [stored];
      const locations = credentials.flatMap((credential) => credential.type === "api_key" ? [credential.key] : []);
      if (locations.length !== credentials.length) {
        log.warn("a stored Claude login has a shape that the conversion does not know, so it is kept");
        return;
      }
      const found = new Set(accounts(access.authDirectory).map(({ configDir }) => configDir));
      await deleteProviderCredentials(CLAUDE_AGENT_SDK_PROVIDER_ID, access, classifySlot);
      for (const location of locations.filter((candidate) => !found.has(candidate))) {
        log.warn("a stored Claude login directory is no longer used, so its account must be added again from Authentication", { configDir: location });
      }
      log.info("converted the stored Claude logins of the Agent SDK prototype", { instances: locations.length });
    },
  };
}

/** The earlier native Anthropic Subscription provider, which ran the Claude.ai OAuth itself and stored its tokens in
 *  auth.json. Remove with its conversion after 2027-04-08. */
const RETIRED_SUBSCRIPTION_PROVIDER_ID = "claude_subscription";

type SubscriptionAccount = Extract<AccessProviderAccountIdentity, { readonly kind: "subscription" }>;
const StoredOAuthInstancesSchema = Schema.Array(CredentialInstanceSchema);
type StoredOAuthInstance = CredentialInstance & { readonly credential: OAuthCredential };

/** The parsed auth.json object, or `undefined` when it is missing, oversized, unparseable, or not an object. Those
 *  conditions belong to the auth store, whose readers report them. */
function storedAuthJson(access: AuthProfileAccess): UnknownRecord | undefined {
  try {
    const bytes = access.readFile(AUTH_STORE_FILE, 16 * 1024 * 1024);
    const parsed: unknown = bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The OAuth instances that auth.json holds for the retired provider, `undefined` when it holds no entry there, or
 *  `"unknown"` when the entry has any other shape. The tokens stay in the decoded value and go no further. */
function storedOAuthInstances(access: AuthProfileAccess): { readonly raw: unknown; readonly instances: readonly StoredOAuthInstance[] } | "unknown" | undefined {
  const store = storedAuthJson(access);
  if (store === undefined || !Object.hasOwn(store, RETIRED_SUBSCRIPTION_PROVIDER_ID)) return undefined;
  const raw = store[RETIRED_SUBSCRIPTION_PROVIDER_ID];
  const decoded = Schema.decodeUnknownResult(StoredOAuthInstancesSchema, { onExcessProperty: "error" })(raw);
  if (Result.isFailure(decoded)) return "unknown";
  const instances = decoded.success.filter((instance): instance is StoredOAuthInstance => instance.credential.type === "oauth");
  return instances.length === decoded.success.length ? { raw, instances } : "unknown";
}

/** Removes the retired provider's entry while it still holds `expected`. The other entries keep their exact values,
 *  because the store's decoder rejects a file that names a provider it does not know. */
async function removeRetiredEntry(access: AuthProfileAccess, expected: unknown): Promise<boolean> {
  return access.withLock(() => {
    const store = storedAuthJson(access);
    if (store === undefined || !isDeepStrictEqual(store[RETIRED_SUBSCRIPTION_PROVIDER_ID], expected)) return false;
    access.writeFile(AUTH_STORE_FILE, JSON.stringify(Object.fromEntries(Object.entries(store).filter(([key]) => key !== RETIRED_SUBSCRIPTION_PROVIDER_ID))));
    return true;
  });
}

/**
 * Converts the profile state of the earlier native Anthropic Subscription provider, which this provider replaced. Each
 * stored instance names its Claude account by its credential's account id, which is the CLI login's account id, or
 * else by the email of an account that a login of this profile holds now. The conversion moves the model choices
 * and paid-use decisions of each named account to this provider's account, and then deletes every stored instance
 * with its tokens. It reads no token's value and logs none. The person's own `claude` login is never a login of
 * a profile (user decision 2026-10-09), so a converted account usually has no login yet: the person must log in to
 * it once for Flywheel. That is the one approved exception to the rule that an update never asks for a new login.
 * An account with no login in this profile keeps its moved choices under its account id until it logs in, and one
 * warning names it. An account that names no account id and matches no login keeps nothing, and one warning names
 * it. The conversion that deletes the tokens also tells the person once, through the notify seam, which accounts
 * need a login, so a run without that seam converts no profile that holds such an account. When a move fails, the
 * instances and their tokens stay and a warning says so, and the next start tries again. An entry of any other
 * shape keeps its bytes, and a warning says so. The auth store refuses every change to a profile whose auth.json
 * names a provider it does not know, so this conversion runs before the store decodes the profile.
 * Remove this conversion and its test after 2027-04-08, by which time every home has converted.
 */
export function replacedSubscriptionConversion(accounts: (authDir: string) => readonly ExternalAccount[]): AuthProfileConversion {
  return {
    phase: "before-decode",
    convert: async ({ access, notify }) => {
      const stored = storedOAuthInstances(access);
      if (stored === undefined) return;
      if (stored === "unknown") {
        log.warn("a stored credential of the earlier native Anthropic Subscription provider has a shape that the conversion does not know, so it is kept");
        return;
      }
      const current = accounts(access.authDirectory);
      const transfers: { readonly from: SubscriptionAccount; readonly to: SubscriptionAccount }[] = [];
      const withoutLogin: string[] = [];
      for (const instance of stored.instances) {
        const accountId = instance.credential.accountId ?? current.find(({ identity }) => identity === instance.identity)?.accountId;
        if (accountId === undefined) {
          log.warn("a Claude account of the earlier native Anthropic Subscription provider has no Claude account id and no Claude login in this profile, so its saved choices stay behind; log in to it from Authentication", { identity: instance.identity });
          withoutLogin.push(instance.identity);
          continue;
        }
        if (!current.some((account) => account.accountId === accountId)) {
          log.warn("a Claude account of the earlier native Anthropic Subscription provider has no Claude login in this profile; log in to it from Authentication", { identity: instance.identity });
          withoutLogin.push(instance.identity);
        }
        transfers.push({ from: { kind: "subscription", providerId: RETIRED_SUBSCRIPTION_PROVIDER_ID, instanceId: instance.id }, to: { kind: "subscription", providerId: CLAUDE_AGENT_SDK_PROVIDER_ID, instanceId: accountId } });
      }
      // The conversion deletes the only record of the accounts that need a login, so a run that cannot tell the
      // person, such as a headless run, leaves the profile for a run that can.
      if (withoutLogin.length > 0 && notify === undefined) {
        log.info("left the stored logins of the earlier native Anthropic Subscription provider for a run that can tell the person which accounts need a login", { instances: stored.instances.length });
        return;
      }
      // The stored entry is the only record of which account each moved choice came from, so a move that fails
      // keeps it, and the next start tries again. A move that succeeded has left nothing to move a second time.
      let preferences: number;
      let decisions: number;
      try {
        preferences = await transferProviderModelPreferences(access, transfers);
      } catch (error) {
        log.warn("the model choices of the earlier native Anthropic Subscription provider could not be moved, so its stored sign-in stays until the next start tries again", { error: errorMessage(error) });
        return;
      }
      try {
        decisions = await transferSubscriptionSpendDecisions(access, transfers);
      } catch (error) {
        log.warn("the paid-use decisions of the earlier native Anthropic Subscription provider could not be moved, so its stored sign-in stays until the next start tries again", { error: errorMessage(error) });
        return;
      }
      const removed = await removeRetiredEntry(access, stored.raw);
      log.info("converted the stored logins of the earlier native Anthropic Subscription provider", { instances: stored.instances.length, preferences, decisions, removed });
      if (removed && withoutLogin.length > 0) notify?.(accountsWithoutLoginNotice(access.authDirectory, withoutLogin));
    },
  };
}

/** The one notice of a conversion that left accounts without a login in the profile: it names each account and says
 *  why the person's own `claude` login does not serve it. Its source id names the profile, so each profile says it
 *  once. */
function accountsWithoutLoginNotice(authDirectory: string, identities: readonly string[]): NotificationOccurrence {
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(identities);
  const digest = createHash("sha256").update(authDirectory).digest("hex");
  return {
    sourceId: `claude-subscription-conversion:${digest}`,
    title: identities.length === 1 ? "A Claude account needs a login" : "Claude accounts need a login",
    message: `The ${CLAUDE_AGENT_SDK_LABEL} provider now keeps a Claude login of its own in each profile and no longer uses the ${LOGIN_PROGRAM_LABEL} login. Log in to ${names} from Authentication to use ${identities.length === 1 ? "it" : "them"} again.`,
    severity: "warning",
    action: { kind: "open-auth-provider", providerId: CLAUDE_AGENT_SDK_PROVIDER_ID },
  };
}
