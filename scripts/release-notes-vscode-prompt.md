You are writing public release notes for the Flywheel VS Code extension and the shared agent runtime bundled with it. The evidence contains only extension-specific and shared-runtime commits since the previous Marketplace release.

Rules:

- Describe only behavior that users receive through the VS Code extension or its bundled shared runtime
- Never describe terminal-interface behavior, even if a changed path or commit detail mentions the terminal client
- Name the VS Code extension when an entry changes its interface. Do not present an extension-only fix as a change to Flywheel everywhere
- Keep the section structure (Added, Fixed, Changed, Performance) but drop empty sections
- Before writing, scan the newest-first evidence in reverse chronological order and build a ledger of user-facing feature families. An introducing feat commit makes that whole capability new in this release
- Treat the previous release as the public availability boundary. When this range introduces a feature and later commits fix, redesign, rename, optimize, or complete it before release, collapse that whole development history into one Added entry that describes only the final feature users receive
- Never write separate Fixed, Changed, or Performance entries for intermediate states of a feature introduced in this same range. Do not mention that the new feature was previously broken, incomplete, organized differently, or restored during development
- Group by the user-facing capability, not by commit type, scope, changed path, implementation unit, or internal project plan. Use one entry for each new feature even when many commits and subsystems produced it
- Treat the extension host, webview, shared runtime, recovery, reconnection, safety, and performance work required to make one new capability operate as parts of that same feature family
- Before returning output, reconcile every Added family against Fixed, Changed, and Performance. A family introduced in this range must appear exactly once under Added and nowhere else; merge material final-state details into its Added entry and delete the duplicate entries
- Keep separate Fixed, Changed, or Performance entries only for behavior that was already available before this release boundary
- State both the outcome and the material mechanism when the evidence supports it
- Use commit bodies and changed paths as evidence for the mechanism, but never print hashes, scopes, file names, or internal module names
- Do not infer a mechanism that the evidence does not support
- Lead each section with the most significant entries
- Use one line per entry, imperative or declarative, with no trailing period, marketing language, exclamation marks, emojis, or em dashes
- Do not invent changes, omit a user-visible change, or repeat behavior shipped before the stated release range
- Drop CI, build tooling, release process, repository housekeeping, internal refactors, benchmarks, and test-only work
- Start with a two- or three-sentence paragraph that summarizes the release theme

Return the release notes in the JSON result format specified in the task.
