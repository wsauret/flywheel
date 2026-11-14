# plan-quality-wiki-cache: seeded defect rationale

## invalidate-is-exact-key (key_files, phase-1/t1, phase-1/t2)

The plan says "invalidate(prefix) removes every entry whose key starts with the prefix, so one call clears all cached views of a page", and phase-1/t2 relies on it: `deps.cache.invalidate(pageCachePrefix(page.slug))` with the prefix `page:<slug>`. In src/cache.ts, `invalidate(key)` is `this.#entries.delete(key)`, an exact delete. renderPage stores the views under `page:<slug>:html` and `page:<slug>:print`; no entry has the key `page:<slug>`, so the call removes nothing, and readers see the old page for up to ten minutes, which is the problem the request asks to fix. The claim is about existing code and is false.

The defect is easy to skim past because the other half of the plan is right: the section index key `section:<section>` is an exact key, so that invalidation works, and phase-1/t1 even gives the prefix its own well-named helper. The planned first test scenario would fail when run, but the plan presents the design as settled on the false claim.

## What is intended

- One process: README.md says the handbook runs as one process, so clearing the in-process cache is enough. No cross-process invalidation is missing.
- Reading the previous version before the save is how the plan finds the old section of a moved page; that is required by requirement 2.
- Keeping the cache and its lifetime is the request's own constraint.
- The key helpers in phase-1/t1 give the key shapes one home; they are a small, justified change.
