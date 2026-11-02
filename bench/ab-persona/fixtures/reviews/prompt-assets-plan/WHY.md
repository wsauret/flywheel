# prompt-assets-plan: seeded defect rationale

This fixture is a real production plan (session dc7c6e702493, plan-create handoff at event position 5778787, 2026-07-28) reviewed against the real codebase at commit 5ca69a4c3, the workspace state when the production plan review ran. The sandbox is a `git archive` of that commit. Six defects were seeded by mutating the plan text; the embedded verbatim user description is authentic and untouched, so several defects contradict the plan's own authoritative spec as well as the code.

## reexport-shim (phase-1 t1 + pattern + scenario)

The original plan removed the systemPrompt export from workflow registration and updated every import, and its patterns section cited ADR-005's ban on forwarding-address shims. The mutation keeps `register.ts` as a compatibility re-export "so existing imports keep working", deletes the ADR citation, and adds a scenario asserting the re-export resolves. The embedded spec still says "Do NOT create re-export shims; update every import."

## infra-imports-workflows (phase-1 t1 + scenario)

The original plan moved `defaultUserDefinitionsRoot` into the infra loader. The mutation has the infra resolver import it from `src/workflows/loader.ts` "to avoid duplicating the path logic", and rewrites the scenario that previously asserted check:boundaries reports no infra import from workflows. infra imports nothing from src/, so this fails the boundary gate by construction.

## core-order-misstated (key_files)

The original plan correctly described buildSystemPromptParts as placing the universal core first for every prompt kind. The mutation claims that for subagents the core is appended after persona instructions, "so moving the core cannot change subagent prompt ordering". The code places the core first for all kinds, and the embedded spec says so explicitly.

## catalog-names-renamed (phase-2 t1 + scenario + success criterion)

The original plan preserved every catalog name verbatim because plan-review.md matches finding Failure paragraphs against them and reviewer-protocol.md tells reviewers to lead with them. The mutation "tightens" names for concision (Forwarding Chain -> Needless Indirection, Premature Abstraction -> Early Abstraction) and weakens the verbatim-name scenario and success criterion to match. The consumers still match the old names, so routing silently breaks.

## manifest-restore-dropped (phase-1 t2 + constraint + scenario + directive d3)

The original plan populated and restored both checked-in manifests in one guarded lifecycle. The mutation declares the restore unnecessary for the infra manifest because its content is "deterministic", leaving a tracked source file populated after every binary build. The existing build-binary lifecycle restores generated content in finally precisely so checked-in manifests stay empty in development.

## reviewer-doctrine-deleted (phase-3 t1 + scenarios + directive d2)

The original plan merged the conventions Output Rules, P1/P2/P3 ladder, reference format, and False-Positive Suppression into reviewer-protocol.md. The mutation calls them "near-duplicates of guidance reviewer subagents already receive" and deletes them with the file. At this commit the overlap is only the four-slot Failure format; the ladder, word caps, reference format, and suppression cases exist nowhere else, so the deletion removes load-bearing reviewer doctrine the embedded spec requires rehoming.
