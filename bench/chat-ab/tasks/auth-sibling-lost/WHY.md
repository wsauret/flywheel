# auth-sibling-lost

Reference: `reference.patch`, the fix against the bugged sandbox. It returns the tree to the base commit.

Base commit: `85c69871d53e3f1dba2532773dd7db38a93c41b3`, a public commit of `main` that holds the fix. `sandbox.patch` puts the defect back. The defect first shipped before the source became public, and its original fix was "fix(auth): keep healthy accounts when a stored sibling is malformed".

## The bug

An explicit API key login calls `replaceRejectedProviderCredentials` (or its receipt variant) in `src/infra/auth/auth-store-mutations.ts`. That function treated a provider as "rejected" when the decoder dropped the whole provider entry, and also when any one account in the provider's collection produced an `invalid_instance` diagnostic. In the second case it replaced the whole collection with the new credential. One damaged account therefore silently deleted every healthy sibling account. The fix qualifies only a wholly dropped provider entry for replacement. A damaged collection now falls through to the ordinary add path, which refuses the write and keeps every byte.

## Why it is a fair task

The user sees a lost account after a login. The cause is a decode classification inside the auth store mutation layer. The solver must trace `loginWithApiKey` in `src/orchestration/auth/auth-actions.ts` to the store mutation functions, then read the store decoder in `src/infra/auth/auth-store.ts` to understand the difference between a dropped provider and an invalid instance. Both replacement variants carry the same faulty predicate, so a fix to one of them is not enough for the receipt path that login uses. The change is 14 lines in 1 file.

## Acceptance

`acceptance/auth-sibling-lost.test.ts` comes from the fix commit's change to `tests/unit/orchestration/auth/auth-actions.test.ts`. Test 1 is the existing repair case: a wholly rejected provider entry must still be replaced. Test 2 stores a healthy and a damaged OpenCode Go account, logs in with a new key, and requires that both stored accounts survive. The original test also pinned the exact refusal text. The acceptance test accepts either outcome that keeps the user's data: a refusal that leaves `auth.json` byte for byte unchanged, or a successful login that keeps both existing accounts. This rule follows the repository rule that a reader never silently discards user state.

## Validation

The sandbox is built from `task.json`: a git archive of the listed paths at the base, then `sandbox.patch`, `bun install`, and a baseline commit. `sandbox.patch` sets the bunfig test root to `.`. It restores the pre-fix predicate and doc comments of both replacement functions in `src/infra/auth/auth-store-mutations.ts`, and it returns the repair test in `tests/unit/orchestration/auth/auth-actions.test.ts` to its state before the fix (old name, no damaged-collection case), so the unit suite passes on the bugged tree as it did before the fix.

- Base: 1 pass, 1 fail (the stored collection holds only the new account).
- Base plus `reference.patch`: 2 pass, 0 fail:

```
bun --env-file=.env.test --conditions=browser bench/chat-ab/check-task.ts auth-sibling-lost --apply-diff bench/chat-ab/tasks/auth-sibling-lost/reference.patch
```
