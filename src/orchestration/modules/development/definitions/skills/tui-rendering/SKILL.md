---
description: Use when implementing or reviewing OpenTUI text, layout, selection, focus, and render behavior.
related: solid-reactivity, flywheel-uat
---

# TUI Rendering

Input: intended OpenTUI output or interaction, derived state, width and height constraints, focus behavior, and Flywheel acceptance scenario.

Keep domain decisions outside rendering. Compose selectable logical lines as one text element with styled chunks and use boxes only for layout or interaction. Define width, wrapping, clipping, overflow, focus, keyboard, mouse, and empty-state behavior. Keep rendering side effects out of stdout and stderr. Inspect stable identity and render cost for repeated items. Run static tests, then use `flywheel-uat` for the live Flywheel scenario.

For dependency or renderer changes, map each workaround to its observable contract and owning test. Remove it only after an isolated candidate-version probe preserves the contract; keep the test. Remeasure entry points after import removal: imports can have side effects, such as a preload. Assert first-painted-frame text and style after resize, reveal, growth, or visibility changes, before later renders can hide defects. Use native dispatch for press, motion, a paint during capture, release, target change without motion, and the next gesture. Prove native graphics claims (image placement, clipping) through protocol output and geometry with controlled frame scheduling, not character snapshots.

Follow PI-INTERACTION-062 in `docs/product-intent/interaction.md`: keep each surface mounted while its subject exists, preserve local UI state, and patch runtime updates in place. During recovery, hold actions that need current data, not the surface.

Stop when target and boundary sizes render and interact correctly in the installed TUI. Return rendered behavior, layout and interaction cases, commands, observed pane evidence, and limitations. If live evidence is unavailable, report the missing host prerequisite and leave the visual claim unverified. Generic `uat` is not a dependency.