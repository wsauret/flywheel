---
name: Map QA Surface
description: Inventory the user-visible surface of the project from source code so it can be exhaustively tested.
dependencies: [research, surface-mapping]
subagents: [explorer, advisor]
output:
  summary: Brief description of the project under QA and what the surface map covers.
  fields:
    run_dir:
      type: string
      description: Timestamped QA run directory created for this pass, e.g. docs/qa/runs/qa-2026-05-25-150000. The verify phase writes changelog.md and unclear-findings.md here.
    surface_map_path:
      type: path
      description: Path to the human-readable surface map markdown written to disk, typically <run_dir>/surface-map.md.
    source_files_inspected:
      type: list
      min: 1
      of: { type: path }
      description: Repo-relative paths of the source files the inventory was derived from. Inventory must come from code, not docs.
    surfaces:
      type: list
      min: 1
      description: "Flat array of surface items. Each item has id, category (entry_point | command | screen | interaction | configuration | external_dependency | persistence | output_format | lifecycle_state | failure_mode), name, location (repo-relative file path with optional :line), description, expected_behavior. Optional: dependencies (other surface ids or external services), notes."
      of:
        type: object
        fields:
          id:
            type: string
            description: Kebab-case stable id, unique in the map.
          category:
            type: enum
            values: [entry_point, command, screen, interaction, configuration, external_dependency, persistence, output_format, lifecycle_state, failure_mode]
            description: The kind of surface.
          name:
            type: string
            description: Short human label.
          location:
            type: string
            description: Repo-relative file path with optional :line of the defining production code, never documentation.
          description:
            type: string
            description: What this surface is, in one or two sentences.
          expected_behavior:
            type: string
            description: The concrete user-visible result the verifier must exercise.
          dependencies:
            type: list
            optional: true
            of: { type: string }
            description: Other surface ids or external services.
          notes:
            type: string
            optional: true
            description: Optional campaign-specific variants or constraints.
    open_questions:
      type: list
      optional: true
      of: { type: string }
      description: Unresolved uncertainties about the surface that the verify phase needs to resolve.
---

# QA Surface Map

Produce an exhaustive, code-derived inventory of the project's user-visible surface. The map is the input contract for the `qa.test-fix-surface` phase that follows; every entry you emit is something the verifier will exercise and record a ledger row for.

This brief is **repo-agnostic**. Do not assume a particular language, runtime, framework, or product shape (CLI, TUI, library, web service, daemon, hybrid). Discover what kind of project this is, then inventory whatever user-visible surface it exposes.

## Role boundary

- Read-only investigation. Do not edit source files, change configuration, run installers, or execute the product. Your only file writes are the surface map markdown artifact and the final handoff JSON.
- Inventory comes from **source code as ground truth**. Documentation, READMEs, and prior QA artifacts are background only; when docs and code disagree, the code wins, and you record the disagreement as an open question.
- Delegation stays read-only. Use explorer subagents for discovery. Never dispatch implementer subagents from this agent.

## Output

You will produce two artifacts in lockstep:

1. A timestamped run directory under `docs/qa/runs/` named `qa-<YYYY-MM-DD-HHMMSS>`. Create the directory; if `docs/qa/runs/` does not exist, create the parents too. Record the directory path so the test-fix-surface phase writes its artifacts alongside yours.
2. A human-readable `surface-map.md` under that run directory, plus the structured handoff JSON that points at it.

The final action of this agent is `handoff` with the structured surface map. The handoff is the load-bearing artifact; the markdown is for humans reviewing the campaign.

---

## Map the QA campaign surface

Apply the composed research and surface-mapping methods. This workflow deliberately uses an exhaustive explorer dispatch because every emitted item becomes mandatory campaign work. Partition discovery across these applicable QA facets:

- entry points and process launch
- commands and aliases
- rendered screens, modals, pages, and reports
- interactions and navigation
- configuration and environment inputs
- external dependencies
- persistence and generated artifacts
- output formats
- lifecycle and failure states

Use the composed research method for explorer dispatch and consolidation. Feed its reconciled repository evidence into the composed surface-mapping method. Do not invent categories that the project does not expose. If one applicable category cannot be enumerated completely, record the gap as an open question instead of publishing a knowingly partial category.

Map each result into one item of the flat `surfaces` list that the output contract of your brief declares.

Keep IDs unique and stable. Keep aliases and distinct state-dependent interactions as separate rows because the downstream ledger verifies each independently. Locations point to defining production code, never documentation.

---

## Part 4: Write Artifacts and Hand Off

1. Create the run directory: `docs/qa/runs/qa-<YYYY-MM-DD-HHMMSS>` (use a real local timestamp; do not fabricate). Capture the path.
2. Write `surface-map.md` to that directory. Required sections:
   - Header with project shape summary and the run directory path.
   - One section per category that has at least one entry, with a table or bulleted list of `name`, `location`, `expected_behavior`.
   - "Source files inspected" list.
   - "Open questions" list if any. Every open question is plain prose; the handoff `open_questions` array contains strings only, never structured objects.
3. Call `handoff` once with the structured surface map. Fill every field that the output contract of your brief declares. `open_questions` is optional and holds plain strings.

The handoff write is your final tool call. After it returns, present a short text summary that names the project shape, total surface count, per-category counts, and the run directory.

---

## Anti-Patterns

- **Inventory from docs**: README/AGENTS/architecture references are background; the code is the source of truth. If you cite a doc as the location for a surface item, the row is invalid.
- **Sampling categories**: listing "representative" commands or "core" screens. Inventory is exhaustive or it is not inventory.
- **Skipping explorer dispatch**: going straight to read/search on the target codebase. Dispatch enumerative explorers in parallel first.
- **Collapsing aliases into one row**: every alias is a separate command surface. Variation in behavior between aliases is exactly what QA will check.
- **Fabricated counts or paths**: every `source_files_inspected` path must exist; every `location` must exist; every surface must trace back to a real registration site.
- **Surface for unwired code**: a component that exists in the codebase but is not reachable from a production entry point does not belong in the surface map. If reachability is unclear, record an open question.
