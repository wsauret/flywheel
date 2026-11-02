import { Redacted } from "effect";
import { apiKey, type AuthContext } from "../../src/infra/auth/auth-context.js";

/** The per-credential state the providers map holds, derived from the context so the test helper names no source-private type. */
type ProviderAuthState = AuthContext["providers"] extends ReadonlyMap<string, infer State> ? State : never;

type KeyInput = string | Redacted.Redacted<string>;

export interface AuthProvidersInput {
  /** A map to start from, when a fixture extends another. */
  readonly base?: ReadonlyMap<string, ProviderAuthState>;
  /** Credential ids the account holds a stored API key for; a plain string is wrapped. */
  readonly apiKeys?: { readonly [providerId: string]: KeyInput };
  /** Credential ids the account holds an OAuth credential for. */
  readonly oauth?: readonly string[];
  /** Credential ids to remove from the base. */
  readonly without?: readonly string[];
}

/** The providers map an AuthContext carries, from the credentials a test states. */
export function authProviders(input: AuthProvidersInput = {}): ReadonlyMap<string, ProviderAuthState> {
  const providers = new Map<string, ProviderAuthState>(input.base ?? []);
  for (const id of input.without ?? []) providers.delete(id);
  for (const [id, key] of Object.entries(input.apiKeys ?? {})) providers.set(id, { kind: "api_key", key: typeof key === "string" ? Redacted.make(key) : key });
  for (const id of input.oauth ?? []) providers.set(id, { kind: "oauth" });
  return providers;
}

/** An AuthContext with the credentials a test states and nothing else. */
export function testAuthContext(input: AuthProvidersInput & Partial<Pick<AuthContext, "credentialLineages" | "droppedCredentials" | "conditions">> = {}): AuthContext {
  return {
    providers: authProviders(input),
    credentialLineages: input.credentialLineages ?? {},
    droppedCredentials: input.droppedCredentials ?? [],
    ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
  };
}

/** The stored API key an AuthContext holds for one credential id, as the
 *  plain string an assertion compares; undefined when none is stored. */
export function plainApiKey(auth: AuthContext, providerId: string): string | undefined {
  const key = apiKey(auth, providerId);
  return key === undefined ? undefined : Redacted.value(key);
}
