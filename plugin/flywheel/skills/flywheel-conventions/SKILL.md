---
name: flywheel-conventions
description: Shared conventions for Flywheel subagents. Tool discipline, output format, research patterns.
user-invocable: false
---

## Tool Discipline

**BLOCKING: Never use Bash for operations that have a dedicated tool.**

- **Content search**: Use **Grep**, not `grep`/`rg` via Bash
- **File search**: Use **Glob**, not `find`/`ls` via Bash
- **File reading**: Use **Read**, not `cat`/`head`/`tail` via Bash

Bash is only for: git commands, `bun` commands, and system operations with no dedicated tool.

---

## Output Rules

**Limits**: Locators 500 words. Analyzers 1500. Reviewers: return valid JSON conforming to flywheel/schemas/findings.schema.json; no word limit on the JSON object.

**Format**: Structured sections (End Goal, Key Findings, Files Identified). Paths only, never file contents. Flag ambiguities with "OPEN QUESTION:".

**Severity**:
- **P1**: High-impact defect — security, data loss, breaking change, or likely hit in normal usage. BLOCKS MERGE.
- **P2**: Moderate issue with real downside (edge case, perf regression, maintainability trap). Fix if straightforward.
- **P3**: Low-impact, narrow scope. User's discretion.

**References**: Always `path/to/file.ts:42-67`, never "in the auth module."

---

## False-Positive Suppression

Rules apply to both code-review (scope: code) and plan-review (scope: plan). Core rule: do not emit findings without a concrete, named consequence.

**Universal (both scopes)** — do NOT emit if:

- **Generic "consider adding" advice** — if you cannot name what concretely breaks (now, or when the plan is implemented), do not flag
- **Speculative future-work** — "might break under load" / "might not scale" without evidence the concern is reachable

**Code-review only** (scope: code):

- **Already handled elsewhere** — check callers, guards, middleware, framework defaults before flagging
- **Restates existing behavior** — "consider extracting a helper" when the code already is a small helper; "add a guard" when a guard one line up enforces it
- **Style a linter would catch** — formatting, unused vars, import order belong to the toolchain

**Plan-review only** (scope: plan):

- **BC ID naming nitpicks** — unless the ID violates a convention documented in the schema
- **Alternative approaches without a concrete break** — "consider X architecture instead of Y" without naming what breaks about Y when implemented
- **Scope creep suggestions** — "also add Z while you're at it"; review evaluates the stated plan, not expansions to it

A suppressed finding is better than a noisy one. If in doubt between "flag weakly" and "suppress", suppress.

---

## Finding Quality: Lead with Observable Behavior

For every finding, the `what_wrong` field must lead with what breaks, for whom — not with code or plan structure.

**Code findings** (scope: code) — describe what breaks NOW:

- **Weak**: "The function parseDate() doesn't validate input format."
- **Strong**: "Users submitting dates in DD/MM/YYYY hit a silent parse error that logs them out. parseDate only accepts YYYY-MM-DD and returns null; the caller doesn't check."

**Plan findings** (scope: plan) — describe what WILL break when the plan is implemented:

- **Weak**: "Phase 2 doesn't specify error handling."
- **Strong**: "When the network request in Phase 2 fails, users will see a crash. The plan doesn't specify fallback UI or retry logic, and BC-AUTH-003 ('graceful network failure') has no task claim."

If you cannot name a concrete observable consequence — present or anticipated (wrong result, unhandled error, contract mismatch, security exposure) — the finding is advisory. Mark it P3 or suppress.

---

## Spec Quality Bar

Before emitting `spec.json`, verify each phase contains:

- Clear goal and success criterion
- Repo-relative file paths (never absolute)
- Enumerated test scenarios specific enough that the implementer doesn't invent coverage
- Explicit verification command
- Clear dependencies (`depends_on`) if any

A spec is ready when an implementer can start confidently without needing to infer.

BC coverage rule: every BC must have at-least-one task claim (orphans = error). Multiple task claims surface as Open Question during consolidation (not automatic failure). BC IDs must be unique within a spec.

If any phase fails the bar, loop back: read the codebase, ask the user, or defer the phase explicitly as `status: deferred` with rationale.

---

## Research Agent Behavior

**Documentarian mode** (locators + analyzers): Document what IS, not what SHOULD BE. No suggestions, critiques, or recommendations.

**Read files fully**: Use Read WITHOUT limit/offset. Partial reads cause hallucination.

---

## Dispatch Patterns (for orchestrators)

### Locator → Analyzer (two-pass research)

1. **Locators first** — run in parallel
   - `locator-codebase`, `locator-patterns`, `locator-docs` (haiku)
   - `locator-web` (sonnet — query crafting needs stronger reasoning)
   - No Read tool — return paths/URLs only
   - Pass search context inline (locators can't read files)

2. **Analyzers second** — targeted, use sonnet
   - `analyzer-codebase`, `analyzer-patterns`, `analyzer-docs`
   - Feed only the top 15 findings from locators
   - Pass file paths, not content (analyzers have Read)
   - Documentarian mode — no suggestions

### Model inheritance

Implementation subagents (`general-purpose`, `Explore`, `Plan`) inherit the parent model — never set `model`. Only research agents (locators, analyzers) use explicit models.

### Input context

Pass file paths (not content) to Read-capable agents. Content inline to locators. Phase-only plan excerpts, not full plans. Under 100 lines where possible.

---

## Error Protocol

3 strikes then escalate:
1. **Diagnose** — read error, identify root cause, targeted fix
2. **Alternative** — different method/tool/approach. Never repeat same failing action.
3. **Rethink** — question assumptions, search for solutions
4. **Escalate** — log attempts, explain to user, ask for guidance

---

## Rationale Discipline

Every line in a SKILL.md loads on every invocation. Include rationale only when it changes what the agent does at runtime. If behavior would not differ without the sentence, cut it. Extract conditional/late-sequence content to `references/` and load on demand.

---

## Tool Invocation Discipline

**BLOCKING:** helper scripts under `flywheel/synthesizer/` and similar are black-box tools. Do NOT read their source to learn how they work — run `<tool> --help` to see the contract, or follow the invocation example in the calling SKILL.md. If the contract is insufficient, the tool is insufficient: file the gap, don't infer behavior from implementation. Source-reading a tool wastes context and risks building assumptions on internals that may change.

---

## Schema vs Prompt: How to Triage Drift

When agent output violates a schema, pick ONE of three responses — not the fourth:

1. **Schema learns from agent** — the agent surfaced a real field the schema missed (e.g. synthesizer-produced metadata, a legitimately polymorphic value, a useful optional annotation). Extend the schema. Document what the field means.
2. **Prompt tightens** — the agent hallucinated, used a synonym, or forgot a required field. Fix the template, add a BLOCKING directive with a concrete counter-example, or update the SKILL.md. The schema is the contract; the prompt is how we teach the agent the contract.
3. **Template matches schema** — the agent followed stale guidance. The template and schema drifted apart; resync the template to what the schema actually says.

**Never** relax the schema to paper over agent drift. Optional-aliased fields, synonym acceptance, and nullable-where-omit-was-canonical all compound into schema ambiguity that punishes downstream consumers. If the agent consistently chooses a different term than the canonical, that's a signal the canonical is wrong — rename the canonical, don't accept both.

**Decision signal**: if the violation is "the agent did something useful we didn't anticipate", schema learns. If it's "the agent was sloppy", tighten the prompt. If both are tempting, the prompt fix is almost always the right call — schemas drift one way (looser) under repeated pragmatism.
