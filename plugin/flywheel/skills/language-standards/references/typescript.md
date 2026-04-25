# TypeScript Language Standards

## Type Safety (Required)

- NEVER use `any` without strong justification and a comment explaining why
- Leverage union types, discriminated unions, and type guards
- Use proper type inference instead of explicit types when TypeScript can infer correctly
- Prefer `unknown` over `any` for truly unknown types, then narrow
- Use `satisfies` operator for type validation without widening
- Use const type parameters where applicable
- Use `readonly` modifier for data that should not be mutated

## Modern Patterns

- Use ES6+ features: destructuring, spread, optional chaining, nullish coalescing
- Prefer immutable patterns over mutation (`readonly`, `as const`)
- Use functional patterns where appropriate (map, filter, reduce)
- Prefer `async/await` over raw Promise chains
- Use template literal types for string pattern enforcement
- Prefer `Record<K, V>` over `{ [key: string]: V }` for mapped types

## Error Handling

- Use discriminated unions for Result types over thrown exceptions where appropriate
- Type-narrow errors in catch blocks (`if (error instanceof SpecificError)`)
- Never swallow errors silently
- Use `never` type for exhaustive switch/if checks
- Prefer `Error` subclasses over plain objects for thrown values

## Imports

- Group by: external libs, internal modules, types, styles
- Use named imports over default exports
- Use `import type` for type-only imports
- Barrel files (`index.ts`) are acceptable for public APIs, avoid for internal modules

## Testing

- Use descriptive test names that read as specifications
- Prefer `describe`/`it` blocks for organization
- Mock at module boundaries, not implementation details
- Use type-safe mocks (avoid `as any` in tests)
- Test error paths, not just happy paths
- Use `beforeEach` for setup, not shared mutable state

## Performance

- Avoid unnecessary re-renders in React (memo, useMemo, useCallback with purpose)
- Use `Map`/`Set` over plain objects for frequent lookups/membership checks
- Prefer `for...of` over `.forEach()` for early-exit capability
- Be aware of bundle size: tree-shake, lazy-load heavy dependencies
- Avoid deep cloning when shallow copy suffices (`structuredClone` vs spread)
- Use `AbortController` for cancellable async operations
- Avoid creating closures in hot loops

## Anti-Patterns to Flag

- `any` without justification comment
- Type assertions (`as Type`) that bypass narrowing -- prefer type guards
- Nested ternaries deeper than 2 levels
- `!` non-null assertion without safety comment
- `enum` for simple string unions (prefer `type X = 'a' | 'b'`)
- Mutation of function parameters
- Functions longer than ~50 lines without extraction
- `// @ts-ignore` or `// @ts-expect-error` without explanation
- `Promise` constructor anti-pattern (wrapping existing promises)
- Event listener leaks (missing cleanup/removeEventListener)

## Debugging Checklist

When investigating TypeScript issues, check:
- Implicit `any` from untyped dependencies or missing `@types/*`
- `undefined` vs `null` confusion (especially with optional chaining)
- Promise rejection not caught (unhandled rejection)
- Stale closure references in React effects or event handlers
- Type narrowing not persisting across async boundaries
- `===` vs `==` comparison issues with nullish values
- Barrel file circular imports causing undefined at runtime
