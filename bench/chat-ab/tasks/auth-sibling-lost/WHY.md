# auth-sibling-lost

Fix commit: `def651a34848b23ffb4289b7faf5094d870b6e16` fix(auth): keep healthy accounts when a stored sibling is malformed

Base commit: `660a22b5f26b3dcb8d62c6a75143000d0aa81c4c` (the parent of the fix)

## The bug

An explicit API key login calls `replaceRejectedProviderCredentials` (or its receipt variant) in `src/infra/auth/auth-store-mutations.ts`. That function treated a provider as "rejected" when the decoder dropped the whole provider entry, and also when any one account in the provider's collection produced an `invalid_instance` diagnostic. In the second case it replaced the whole collection with the new credential. One damaged account therefore silently deleted every healthy sibling account. The fix qualifies only a wholly dropped provider entry for replacement. A damaged collection now falls through to the ordinary add path, which refuses the write and keeps every byte.

## Why it is a fair task

The user sees a lost account after a login. The cause is a decode classification inside the auth store mutation layer. The solver must trace `loginWithApiKey` in `src/orchestration/auth/auth-actions.ts` to the store mutation functions, then read the store decoder in `src/infra/auth/auth-store.ts` to understand the difference between a dropped provider and an invalid instance. Both replacement variants carry the same faulty predicate, so a fix to one of them is not enough for the receipt path that login uses. The change is 14 lines in 1 file.

## Acceptance

`acceptance/auth-sibling-lost.test.ts` comes from the fix commit's change to `tests/unit/orchestration/auth/auth-actions.test.ts`. Test 1 is the existing repair case: a wholly rejected provider entry must still be replaced. Test 2 stores a healthy and a damaged OpenCode Go account, logs in with a new key, and requires that both stored accounts survive. The original test also pinned the exact refusal text. The acceptance test accepts either outcome that keeps the user's data: a refusal that leaves `auth.json` byte for byte unchanged, or a successful login that keeps both existing accounts. This rule follows the repository rule that a reader never silently discards user state.

## Validation

The sandbox was built from `task.json` (git archive of the listed paths at the base, `sandbox.patch` sets the bunfig test root to `.`, baseline commit, `bun install`).

- Base: 1 pass, 1 fail (the stored collection holds only the new account).
- Base plus the fix commit's `src` changes: 2 pass, 0 fail. Two repeated runs gave the same result.
