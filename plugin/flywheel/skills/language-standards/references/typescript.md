# TypeScript Language Standards

## Type Safety

- No `any` — use `unknown` and narrow. No `Function`. No `// @ts-ignore`.
- **Inference over annotation.** Annotate module boundaries and exported functions. Delete interior annotations the compiler doesn't need.
- **Discriminated unions over optional fields.** Narrow on `kind`, not optional presence.
- **`satisfies` over explicit annotation** when validating shape without widening.
- Use `readonly` for data that should not be mutated.
- Prefer `Record<K, V>` over `{ [key: string]: V }` for mapped types.

## Patterns

- Prefer `async/await` over raw Promise chains
- Use `AbortController` for cancellable async operations

## Error Handling

- Prefer `Error` subclasses over plain objects for thrown values
- Type-narrow errors in catch blocks (`if (error instanceof SpecificError)`)
- Use `never` for exhaustive switch/if checks

## Imports

- Use `import type` for type-only imports
- Named imports over default exports
- No barrel re-exports in internal modules

## Anti-Patterns

- `any` without justification
- Type assertions (`as Type`) that bypass narrowing — prefer type guards
- `!` non-null assertion without safety justification
- `enum` for simple string unions (prefer `type X = 'a' | 'b'`)
- `// @ts-ignore` or `// @ts-expect-error` without explanation
- `Promise` constructor anti-pattern (wrapping existing promises)
- Mutation of function parameters
- Functions longer than ~50 lines without extraction
- Nested ternaries deeper than 2 levels

## Testing

- Descriptive test names that read as specifications
- Mock at module boundaries, not implementation details
- No `as any` in tests — use type-safe mocks
- Test error paths, not just happy paths

## Performance

- Use `Map`/`Set` over plain objects for frequent lookups/membership checks
- Prefer `for...of` over `.forEach()` for early-exit capability
- Avoid deep cloning when shallow copy suffices (`structuredClone` vs spread)
- Avoid creating closures in hot loops
