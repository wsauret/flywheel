import { Effect, Exit, Scope } from "effect";

export interface ScopedAbortSignal {
  readonly signal: AbortSignal;
  readonly scope: Scope.Closeable;
}

export function createScopedAbortSignal(): ScopedAbortSignal {
  const scope = Scope.makeUnsafe("sequential");
  const signal = Effect.runSync(Scope.provide(scope)(Effect.abortSignal));
  return { signal, scope };
}

export function closeScopedAbortSignal(token: ScopedAbortSignal): Effect.Effect<void> {
  return Scope.close(token.scope, Exit.void);
}