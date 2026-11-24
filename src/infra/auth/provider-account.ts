import type { AuthProfileAccess } from "./auth-profile-store.js";
import type { CredentialSlotClassifier } from "./auth-store-types.js";
import type { NotificationOccurrence } from "../notification-episode.js";

/** How the terminal names a credential provider: the `flywheel auth login
 *  --<flag>` spelling and the provider's plain name, which the command line
 *  joins with the sign-in method that the provider's login flow declares. A
 *  provider without a flag is reached by `--provider <id>`. */
export interface CredentialProviderCli {
  readonly name: string;
  readonly flag?: string;
}

/** One account of a login that another program owns. Flywheel holds none of
 *  the login's secrets: it knows only which account it is and where the
 *  program keeps it. */
export interface ExternalAccount {
  /** The program's stable id for the account. */
  readonly accountId: string;
  /** The account as a person reads it, such as an email address. */
  readonly identity: string;
  /** The directory in which the program keeps this login. */
  readonly configDir: string;
  /** The account's plan as the program names it, such as "Claude Max", when the program states it. */
  readonly plan?: string;
  /** The program explicitly classifies this account as usage-only, with no included allowance or paid rollover. */
  readonly billing?: "metered";
}

/** One provider account: a subscription instance, or the provider's single stored credential. */
export type AccessProviderAccountIdentity =
  | { readonly kind: "subscription"; readonly providerId: string; readonly instanceId: string }
  | { readonly kind: "singleton"; readonly providerId: string };

/** The stable key of an account. A record that extends an account, such as a spend-mode candidate, keys as its
 *  account: no other field is part of the key. */
export function accessProviderAccountKey<Account extends AccessProviderAccountIdentity>(account: Account): string {
  return account.kind === "subscription"
    ? JSON.stringify([account.kind, account.providerId, account.instanceId])
    : JSON.stringify([account.kind, account.providerId]);
}

/** One exact account lineage: a provider account and the lineage of the credential that it holds. */
export interface AccountLineage {
  readonly account: AccessProviderAccountIdentity;
  readonly lineage: string;
}

/** Where a provider's credentials live: a stored key, a stored OAuth credential under `credentialId`, or the
 *  accounts that another program holds inside the auth profile directory `authDir`. */
export type CredentialStrategy =
  | { readonly kind: "api_key" }
  | { readonly kind: "oauth"; readonly credentialId: string }
  | {
    readonly kind: "external";
    /** The accounts of the program's logins inside the auth profile directory
     *  `authDir`, each once. A read of the program's files with no launch, so
     *  it is safe at startup. */
    readonly accounts: (authDir: string) => readonly ExternalAccount[];
  };

/** What the credential store reads of a provider: its id, its billing, and where its credentials live. */
export interface CredentialProvider {
  readonly id: string;
  readonly billing: "subscription" | "metered";
  readonly auth: CredentialStrategy;
  /** Conversions of the state that this provider stored in an earlier shape, each with its removal date. */
  readonly profileConversions?: readonly AuthProfileConversion[];
}

/** What a profile conversion reads and writes: the profile, under whose locks it writes, the slot classifier, and
 *  the complete installed credential vocabulary that the store decodes with. */
export interface AuthProfileConversionInput {
  readonly access: AuthProfileAccess;
  readonly classifySlot: CredentialSlotClassifier;
  readonly installedIds: readonly string[];
  /** The notify seam (ARCH-STRUCTURE-034), where a conversion states a condition that the person must act on, such as an
   *  account whose saved choices could not move. Absent where no person reads notifications, such as a headless
   *  run, which states the condition in its log only. */
  readonly notify?: (occurrence: NotificationOccurrence) => void;
}

/** A dated conversion of state that the provider stored in an auth profile in an earlier shape. Profile
 *  normalization runs every installed provider's conversions, also of a provider whose module is off. A
 *  `before-decode` conversion runs before the credential store is decoded, so it can take out an entry that the
 *  current decoder refuses. An `after-decode` conversion runs on a decoded store whose lineages are in place. */
export interface AuthProfileConversion {
  readonly phase: "before-decode" | "after-decode";
  readonly convert: (profile: AuthProfileConversionInput) => Promise<void>;
}

/** Whether another program owns the provider's login. */
export function isExternalLoginDefinition<Definition extends CredentialProvider>(definition: Definition): definition is Definition & { readonly auth: { readonly kind: "external" } } {
  return definition.auth.kind === "external";
}

/** The auth store key this provider's credentials live under. An external
 *  login stores nothing, and its accounts are known under the provider id. */
export function credentialIdOf(definition: Pick<CredentialProvider, "id" | "auth">): string {
  return definition.auth.kind === "oauth" ? definition.auth.credentialId : definition.id;
}
