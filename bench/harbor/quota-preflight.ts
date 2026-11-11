/**
 * The quota preflight of a Harbor run. Before a run queues trials, it reads
 * what the auth profile's own stores know about each account that the arm's
 * snapshot exports: the account-scoped availability authority, which the
 * request walk reads to skip a spent account and which already folds the
 * subscription usage reports. It sends no request and creates no store, so it
 * costs nothing and proves only what that store states. A run whose every
 * account is known to be out of quota until after now is refused, because each
 * of its trials would only wait for the reset until Harbor's agent timeout
 * ends it.
 *
 * An account that the stores cannot describe is reported as not checked and
 * never counts as spent. Such an account is a login token of a provider that
 * takes one, such as the Claude engine route: the snapshot makes each token
 * its own account of the trial profile, which no host store has observed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AccessProviderCandidate, AccessProviderDefinition } from "../../src/infra/llm/access-provider.js";
import { AVAILABILITY_PROTOCOL_VERSION, createAvailabilityAuthority } from "../../src/infra/llm/availability-store.js";
import { environmentAccountHome, FLYWHEEL_DIR_NAME } from "../../src/infra/directory-authorities.js";
import { availabilityAuthorityDbFile } from "../../src/infra/paths.js";
import { createProviderAvailability } from "../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { getAuthStatusWithDiagnostics } from "../../src/orchestration/auth/auth-actions.js";
import { AuthProfileManager } from "../../src/orchestration/auth/auth-profile-manager.js";
import { installedAccessProviderDefinitions, installedAccessProviderSelection } from "../../src/orchestration/credential-provider-modules.js";

/** What the stores state about one account of the arm. */
export type AccountQuota = { readonly providerId: string; readonly account: string } & (
  | { readonly kind: "spent"; readonly untilMs: number }
  | { readonly kind: "open" }
  | { readonly kind: "unchecked"; readonly reason: string }
);

export interface QuotaPreflight {
  readonly profile: string;
  readonly accounts: readonly AccountQuota[];
}

/** What the preflight reads: the host auth profile that the snapshot exports, the arm's credential providers, and
 *  the keychain items of the arm's login tokens, which name those accounts. */
export interface QuotaPreflightRequest {
  readonly authProfile: string;
  readonly credentialProviders: readonly string[];
  readonly tokenKeychainItems: readonly string[];
  readonly projectRoot: string;
  readonly nowMs: number;
  /** The Flywheel data directory; the account home's by default. */
  readonly userDataRoot?: string;
}

/** Reads the preflight of one run from the stores of `request.authProfile`. Throws when that profile does not exist. */
export async function readQuotaPreflight(request: QuotaPreflightRequest): Promise<QuotaPreflight> {
  const userDataRoot = request.userDataRoot ?? join(environmentAccountHome(process.env), FLYWHEEL_DIR_NAME);
  const profile = await new AuthProfileManager({ userDataRoot, projectRoot: request.projectRoot, env: { FLYWHEEL_AUTH_PROFILE: request.authProfile } }).resolve();
  if (!profile.availableProfiles.some(({ id }) => id === profile.id)) throw new Error(`the auth profile ${request.authProfile} does not exist`);
  const definitions = new Map(installedAccessProviderDefinitions().map((definition) => [definition.id, definition]));
  const status = new Map(getAuthStatusWithDiagnostics(profile.directory).providers.map((provider) => [provider.providerId, provider]));
  const unchecked: AccountQuota[] = [];
  const stored: StoredAccount[] = [];
  for (const providerId of request.credentialProviders) {
    const definition = definitions.get(providerId);
    // A web auth provider serves tools, not model requests.
    if (definition === undefined) continue;
    const tokenLogin = tokenLoginVariable(definition);
    if (tokenLogin !== undefined) {
      const reason = "a login token is its own account of the trial profile, which no host store has observed";
      const sources = request.tokenKeychainItems.length > 0 ? request.tokenKeychainItems.map((item) => `token of keychain item ${item}`) : [`token of ${tokenLogin}`];
      unchecked.push(...sources.map((account) => ({ providerId, account, kind: "unchecked" as const, reason })));
      continue;
    }
    // SAFETY: the auth status holds a row for every installed access provider, and `definition` is one.
    const provider = status.get(providerId)!;
    if (provider.accounts.length > 0) {
      for (const account of provider.accounts) stored.push({ account: account.label || account.identity || account.instanceId, candidate: { kind: "subscription", providerId, instanceId: account.instanceId, spendMode: "included" } });
    } else if (provider.source === "stored_key") {
      stored.push({ account: "stored credential", candidate: { kind: "singleton", providerId, spendMode: installedAccessProviderSelection().spendMode(providerId) } });
    }
  }
  return { profile: profile.displayName, accounts: [...await readStoredStanding(userDataRoot, profile.id, stored, request.nowMs), ...unchecked] };
}

/** One account that the profile stores. */
interface StoredAccount { readonly account: string; readonly candidate: AccessProviderCandidate }

/** The host variable of the provider's token login, or undefined for a provider that takes none. */
function tokenLoginVariable(definition: AccessProviderDefinition): string | undefined {
  return definition.auth.kind === "external" ? definition.auth.tokenLogin?.hostVariable : undefined;
}

/** Each stored account's standing: spent until the reset that the availability authority states, else open. The
 *  authority is opened for this read only and closed after it. A data directory without its database has observed
 *  no account, so every account is open and the database is not created. */
async function readStoredStanding(userDataRoot: string, profileId: string, stored: readonly StoredAccount[], nowMs: number): Promise<AccountQuota[]> {
  const dbFile = availabilityAuthorityDbFile(userDataRoot, AVAILABILITY_PROTOCOL_VERSION);
  const open = ({ account, candidate }: StoredAccount): AccountQuota => ({ providerId: candidate.providerId, account, kind: "open" });
  if (stored.length === 0) return [];
  if (!existsSync(dbFile)) return stored.map(open);
  const owner = createProviderAvailability({ authority: createAvailabilityAuthority({ dbFile }), now: () => nowMs });
  try {
    const availability = owner.forCandidates(profileId, stored.map(({ candidate }) => candidate));
    availability.refreshProjection();
    return stored.map((entry) => {
      const standing = availability.genericQuotaStanding(entry.candidate);
      return standing.kind === "suppressed" ? { providerId: entry.candidate.providerId, account: entry.account, kind: "spent", untilMs: standing.exhaustion.resetsAtMs } : open(entry);
    });
  } finally {
    await owner.dispose();
  }
}

/** One line per account, for the launcher's output. */
export function quotaPreflightLines(preflight: QuotaPreflight): string[] {
  return preflight.accounts.map((entry) => {
    const name = `quota preflight: ${entry.providerId} ${entry.account}`;
    switch (entry.kind) {
      case "spent": return `${name}: out of quota until ${new Date(entry.untilMs).toISOString()}`;
      case "open": return `${name}: no store states it out of quota`;
      case "unchecked": return `${name}: not checked, because ${entry.reason}`;
    }
  });
}

/** The refusal of a run whose every account is known to be out of quota after now, or undefined when an account can
 *  serve or was not checked. A run with no account is the snapshot export's to refuse. */
export function quotaRefusal(preflight: QuotaPreflight): string | undefined {
  const spent = preflight.accounts.flatMap((entry) => entry.kind === "spent" ? [entry] : []);
  if (spent.length === 0 || spent.length < preflight.accounts.length) return undefined;
  const until = Math.min(...spent.map(({ untilMs }) => untilMs));
  return `quota preflight refused the run: every account of the auth profile ${preflight.profile} that the arm uses is out of quota, the first until ${new Date(until).toISOString()}; each trial would only wait for that reset until Harbor's agent timeout`;
}
