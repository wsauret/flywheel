import { Effect, Exit, Scope } from "effect";
import { subscribeCustomProviderRetirement } from "../../infra/llm/custom-provider-registry.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { ModelClient, ProviderDemand, ProviderSessionLifetime } from "./llm/types.js";
import type { SharedTree } from "./shared-tree.js";

/** The one client that the runner uses now, the inputs it was built for, and the scope of its provider-session
 *  resources. */
interface CurrentRuntime<Value> {
  readonly composition: FirstPartyModuleComposition;
  readonly connectionGeneration: WeakKey;
  readonly eligibilityGeneration?: WeakKey;
  readonly routingKey: string;
  /** The shared tree that the client captured. The tree ends with its last release, and a client must not keep a
   *  dead tree alive past it: the tree's next holder gets a new tree whose login is the live host's. */
  readonly sharedHost: SharedTree | undefined;
  readonly construction: Promise<Value>;
  readonly scope: Scope.Closeable;
  /** False when the value must not serve a later request, or a custom provider that it may use was retired. */
  reusable: boolean;
}

interface ResolveOptions<Value> {
  readonly eligibilityGeneration?: WeakKey;
  /** The runner's provider-session lifetime. Each client gets its own child scope of it, which the cache closes
   *  when a different client replaces this one. */
  readonly lifetime: ProviderSessionLifetime;
  /** False keeps the built value from serving a later request. */
  readonly retain?: (value: Value) => boolean;
}

/**
 * Runner-owned memoization of provider construction. The runner uses one client at a time: the one built for the
 * request's module composition, account connection generation, routing key, and bound shared tree. A request that needs different
 * inputs replaces that client, and the cache first closes the replaced client's provider-session scope, so a
 * provider process or socket that the client held (such as a Claude CLI) ends at once instead of idling until the
 * runner ends. A replaced client is never returned again: a later request with its inputs builds a new one.
 */
export class ProviderRuntimeCache<Value> {
  private current: CurrentRuntime<Value> | undefined;
  private readonly unsubscribeRetirement: () => void;
  private disposed = false;
  /** The resolve that runs now. A session's runs and its pre-starts share one cache (`ProviderSession`), so resolves
   *  run one at a time: a second resolve sees the client that the first built, and no replaced client escapes the
   *  close of its scope. */
  private resolving: Promise<unknown> = Promise.resolve();

  constructor(subscribeRetirement: typeof subscribeCustomProviderRetirement = subscribeCustomProviderRetirement) {
    this.unsubscribeRetirement = subscribeRetirement(() => {
      if (this.current !== undefined) this.current.reusable = false;
    });
  }

  /** Stops reuse. The owner of the lifetime scope closes the scopes of the clients built in it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = undefined;
    this.unsubscribeRetirement();
  }

  /** Ends the current client and closes its provider-session scope, after the resolve that runs now, so the next
   *  resolve builds a new client. The session's owner calls it when no run of the session uses the client. */
  release(): Promise<void> {
    const released = this.resolving.then(() => this.endCurrent());
    this.resolving = released.catch(() => undefined);
    return released;
  }

  private async endCurrent(): Promise<void> {
    const held = this.current;
    this.current = undefined;
    if (held !== undefined) await Effect.runPromise(Scope.close(held.scope, Exit.void));
  }

  resolve(
    composition: FirstPartyModuleComposition,
    connectionGeneration: WeakKey,
    routingKey: string,
    build: (lifetime: ProviderSessionLifetime) => Promise<Value>,
    options: ResolveOptions<Value>,
  ): Promise<Value> {
    const resolved = this.resolving.then(() => this.resolveNow(composition, connectionGeneration, routingKey, build, options));
    this.resolving = resolved.catch(() => undefined);
    return resolved;
  }

  private async resolveNow(
    composition: FirstPartyModuleComposition,
    connectionGeneration: WeakKey,
    routingKey: string,
    build: (lifetime: ProviderSessionLifetime) => Promise<Value>,
    options: ResolveOptions<Value>,
  ): Promise<Value> {
    const held = this.current;
    const lifetime = options.lifetime;
    const sharedHost = lifetime.sharedHost;
    if (held?.reusable === true && held.composition === composition && held.connectionGeneration === connectionGeneration && held.eligibilityGeneration === options.eligibilityGeneration && held.routingKey === routingKey && held.sharedHost === sharedHost) {
      return held.construction;
    }
    await this.endCurrent();
    const scope = await Effect.runPromise(Scope.fork(lifetime.scope));
    const construction = build({ ...lifetime, scope });
    const entry: CurrentRuntime<Value> = { composition, connectionGeneration, eligibilityGeneration: options.eligibilityGeneration, routingKey, sharedHost, construction, scope, reusable: !this.disposed };
    this.current = entry;
    try {
      const value = await construction;
      if (options.retain?.(value) === false) entry.reusable = false;
      return value;
    } catch (error) {
      // A failed construction holds nothing that a later request can use.
      entry.reusable = false;
      throw error;
    }
  }
}

/** The provider runtime that one session holds across its runs: the client cache, the scope of the
 *  provider-session resources that its clients hold, such as a Claude engine, and the session's engine demand, which
 *  every lifetime of its clients carries (`ProviderSessionLifetime.demand`). A run that takes it neither disposes the
 *  cache nor closes the scope, so those resources outlive the run; the session's owner closes them
 *  (`openProviderSession`). */
export interface ProviderSession {
  readonly cache: ProviderRuntimeCache<ModelClient>;
  readonly scope: Scope.Scope;
  readonly demand?: ProviderDemand;
}

/** A provider runtime that its session's owner holds. */
export interface HeldProviderSession {
  readonly session: ProviderSession;
  /** Stops reuse and closes the scope, which ends every provider resource that its clients hold; a resource that
   *  serves an open request ends when that request ends. */
  close(): Promise<void>;
}

/** Opens a provider runtime of a session whose engine demand `demand` reads, as each run or pre-start finds it. */
export function openProviderSession(demand: () => ProviderDemand | undefined): HeldProviderSession {
  const cache = new ProviderRuntimeCache<ModelClient>();
  const scope = Scope.makeUnsafe("sequential");
  return {
    session: { cache, scope, get demand() { return demand(); } },
    close: async () => {
      cache.dispose();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

export function providerRuntimeRoutingKey(
  model: string,
  providerOptions: ProviderRequestOptions | undefined,
  providerSettings: { readonly [providerId: string]: { readonly [key: string]: number } },
): string {
  return stableValueKey({ model, providerOptions, providerSettings });
}

function stableValueKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValueKey).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableValueKey(entry)}`)
    .join(",")}}`;
}
