---
description: Use when designing or reviewing Solid stores, signals, memos, effects, roots, and derived TUI views.
---

# Solid Reactivity

Input: the TUI state source, mutations, derived views, external events, and component lifetime.

Identify the canonical state owner. Use a signal for scalar state, a store for domain-shaped mutable state, a memo for pure derivation, an effect only for I/O or reconciliation from an external publication, and `batch` for burst updates. Keep producer events raw and consumer filtering local. Create roots only at an explicit lifetime boundary and pair them with `onCleanup` or an owned disposer. Guard asynchronous effects against stale completion and owner disposal. Follow PI-INTERACTION-062 in `docs/product-intent/interaction.md`: a component's lifetime follows the identity of what it shows, never connection or currency state, and UI state the person set lives with an owner that outlives a remount.

For every effect, list its tracked trigger sources and every reactive value it writes. The sets must not overlap. Track only the canonical trigger: use `on` to name dependencies, or read the source first and run all target-state reads and writes inside `untrack`. Never call a broad helper directly from `createEffect` when that helper reads or writes reactive state. A fresh object with unchanged meaning must not create a feedback edge or a second authority.

Verify the production scheduling model, not only the final render. Run Solid effect tests with the `browser` export condition and a real reactive owner. Let the effect subscribe, enter the active nested view, publish a fresh semantically equivalent source value, and assert a bounded run or source-read count, correct state, cleanup, and continued keyboard or mouse input. A default Bun server export can make an effect inert and produce false evidence. When behavior is user-visible, also drive the installed TUI after the asynchronous publication.

Stop when data flows one way and deleting any derived copy does not lose authority. Return primitive and ownership decisions, tracked trigger set, mutation targets, update path, cleanup path, async race handling, and tests or review findings. On failure, report the cycle, shadow state, missing owner, unbounded effect, or inert test environment. Never synchronize two authorities manually.