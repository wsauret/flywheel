---
date: 2026-04-23
status: draft
type: refactor
source: docs/research/2026-04-23-compound-engineering-vs-flywheel.md
origin: rigor-gradient pipeline reshape + targeted CE adoptions
filter: agent-output elegance × token-efficiency
---

# Plan: Rigor-Gradient Pipeline + Targeted CE Adoptions

## Goal

Reshape Flywheel's planning-to-implementation pipeline so that every stage produces a structured, executable artifact (`spec.json`) that `work-implementation` can consume directly. Machine-to-machine handoffs stay structured (JSON); each stage — creation, review, consolidation — produces a spec that's already work-ready. Rigor increases through refinement passes (review + consolidation) when invoked, but skipping them is a first-class workflow, not an error. Then layer targeted compound-engineering adoptions on top to sharpen reviewer quality and reduce noise in agent output.

## Evaluation Filter

Elegance is measured on **agent output** — the code, tests, and review artifacts the agent ships when a skill runs. Not on the skill files themselves. Token efficiency is measured across a full session (draft → review → consolidate → implement → review), not per invocation.

- **Output elegance** — Does the change cause the agent to ship code with fewer moving parts, a single source of truth, fixes targeted at root cause, no ceremony added to satisfy noise findings, no scope creep beyond stated intent?
- **Token efficiency** — Does it reduce tokens spent per cycle: prompts loaded, output generated, re-review and re-work cycles avoided?

Items that win on both are prioritized. Items that win only on token efficiency (skill-file hygiene with negligible effect on agent output) are a distinct, lower-priority tier. Items that hurt either axis are rejected.

---

## Architecture

Machine handoffs stay in a machine format; no boundary parses prose back into structure. **Every stage is independently skippable** — `work-implementation` runs against any `spec.json`, whether it came straight from plan-creation, from a review+consolidation pass, or from a findings.json derived from work-review.

### The pipeline

Each skill operates within the **active session's directory** (`.flywheel/plugin/sessions/<session-id>/`). Artifact filenames below are relative to that dir.

1. **plan-creation** — Specification (best-effort from research). Creates a session, writes `spec.json` directly — structured, conforming to the K2 schema, with `behavioral_contract[]` synthesized from user intent and codebase research. Writes `context.md` sidecar. Updates `session.json` and `.flywheel/plugin/active.json` to point at the new session.

2. **plan-review** — Evaluation. Reads the active session's `spec.json`, dispatches all 6 reviewer agents, writes `findings.json` (separate file, non-destructive on spec.json). Reviewers return findings + open questions + inter-reviewer conflicts as typed fields.

3. **plan-consolidation** — Refinement. Reads `spec.json` + `findings.json` → resolves Open Questions interactively → writes a refined `spec.json` (same file, new version). Runs only when findings exist to integrate.

4. **work-implementation** — Execution. Reads `spec.json` (a full plan) or a session's `review.findings.json` (fix-findings mode). Both deserialize into the same `TaskList` in-memory contract. Writes `baseline.json` at work-start and `state.json` per checkpoint.

5. **work-review** — Evaluation (second pass). Reviews the implementation against `baseline.json`. Writes `review.findings.json` and prints a summary to chat. If invoked standalone (no preceding planned session), creates a review-only session `sessions/review-pr-<n>-<date>/`.

**Skip-review workflow** (a common path): plan-creation → work. `spec.json` from plan-creation is rigorous enough to execute; review and consolidation are refinement passes you can invoke when you want them.

### Artifact map

All session-scoped artifacts live under `.flywheel/plugin/sessions/<session-id>/` (gitignored). Durable team knowledge stays in `docs/` (tracked in git). Authoritative schemas live in the plugin source at `flywheel/schemas/`. See Session Lifecycle below for session ID format and resume mechanics.

**Plugin-source artifacts** (tracked, shipped with the plugin):

| Artifact | Owner / Writer | Editable by | Purpose |
|---|---|---|---|
| `flywheel/schemas/*.schema.json` | plugin author | plugin author | authoritative JSON Schemas (findings, task-list, state, baseline, session) — cited by all producers and consumers |

**Session-scoped artifacts** (under `.flywheel/plugin/sessions/<id>/`, gitignored):

| Artifact | Owner / Writer | Editable by | Purpose |
|---|---|---|---|
| `session.json` | skill that creates session; touched on checkpoint | machine-only | session metadata (status, active_skill, timestamps, artifact pointers) |
| `context.md` | plan-creation | machine | research sidecar (locator/analyzer findings) |
| `spec.json` | plan-creation (writes); plan-consolidation (refines) | user (hand-edits OK — readable JSON) | authoritative executable spec, incl. `behavioral_contract[]` + top-level `summary` |
| `findings.json` | plan-review | machine-only | structured plan-review feedback |
| `baseline.json` | work-implementation | **read-only after work-start** | frozen snapshot of spec; compliance + BC-coverage comparison source |
| `state.json` | work-implementation | machine-only | execution progress: status, timestamps, outcomes, `artifacts`, `commands_run`, `bc_satisfied` per phase |
| `review.findings.json` | work-review | machine-only | structured code-review findings (plan-compliance + BC-coverage + commands-re-exec + reviewer output), with top-level `summary` |

**Global `.flywheel/plugin/` artifacts** (gitignored, cross-session):

| Artifact | Owner / Writer | Editable by | Purpose |
|---|---|---|---|
| `.flywheel/plugin/active.json` | session-creating skills | machine | pointer to the current active session: `{ "session_id": "<id>" }` |
| `.flywheel/plugin/traces/` | (reserved) | machine | future: per-session trace data; persists across session deletion |
| `.flywheel/plugin/log/` | (reserved) | machine | future: plugin logs |

**Durable team knowledge** (stays tracked in `docs/`):

| Artifact | Purpose |
|---|---|
| `docs/standards/` | coding conventions — team-wide, durable |
| `docs/solutions/` | compound knowledge base — the whole point of compound is cross-session sharing |
| `docs/research/` | durable cross-session research documents (e.g., the CE research doc) |

JSON artifacts carry their own natural-language `summary` field. Skills print that summary to chat at completion — no parallel rendered-md artifact is written. Users who want to re-read later can open the JSON directly (the `summary` is human-readable at the top) or ask the agent to re-render on demand.

**.gitignore**: `.flywheel/` is gitignored. `flywheel/` (plugin source, schemas) and `docs/` remain tracked.

### Session Lifecycle

**Session ID format**: `<slug>-<YYYY-MM-DD>`. Example: `add-user-auth-2026-04-23`. Human-readable, tab-completable, collision-safe across reruns on the same day (tiebreak by appending `-2`, `-3` if needed). Matches the existing `docs/research/YYYY-MM-DD-*.md` naming pattern.

**Namespace separation from TUI**: plugin sessions live under `.flywheel/plugin/sessions/`; TUI sessions live under `.flywheel/tui/sessions/` (or wherever the TUI configures them). Clean separation while the two tools have different pipelines; room to converge later if schemas unify.

**Session states** (align with the existing Flywheel state machine — per user memory):
- `active` — work in progress
- `paused` — intentionally set aside, not deleted
- `completed` — ship invoked; work merged

Deletion is an action (`rm -rf <session-dir>` or a future `/fly:session delete`), not a state. Traces under `.flywheel/plugin/traces/` persist across session deletion (future feature; structure is reserved now).

**Active pointer**: `.flywheel/plugin/active.json` points to the current session:
```json
{ "schema_version": 1, "session_id": "add-user-auth-2026-04-23" }
```

**Resume mechanics** — O(1) via the active pointer, no filesystem search:

| Invocation | Behavior |
|---|---|
| `/fly:work` (no args) | Read `active.json` → load that session's `state.json` → resume. |
| `/fly:work <slug>` | Prefix-scan `sessions/<slug>-*` (fast, bounded). If found, update `active.json`, resume. |
| No `active.json`, no args | Error: "No active session. Invoke `/fly:plan` to start one." |
| `/fly:plan <feature>` | Create `sessions/<slug>-<date>/`, write `session.json`, update `active.json`. |

**Multi-session, one-active-at-a-time**: multiple session directories can coexist, but only one is "active" per the pointer. Matches the git `HEAD`/branches model. Expensive scans only happen on explicit listing commands (future `/fly:session list`), never on every skill invocation.

**`session.json` schema** (authored in `flywheel/schemas/session.schema.json`):
```json
{
  "schema_version": 1,
  "session_id": "add-user-auth-2026-04-23",
  "slug": "add-user-auth",
  "status": "active" | "paused" | "completed",
  "started_at": "2026-04-23T14:03:00Z",
  "last_checkpoint_at": "2026-04-23T15:47:00Z",
  "active_skill": "work-implementation" | "plan-creation" | "plan-review" | "plan-consolidation" | "work-review" | null,
  "artifacts": {
    "spec": "spec.json",
    "findings": "findings.json",
    "baseline": "baseline.json",
    "state": "state.json",
    "review_findings": "review.findings.json",
    "context": "context.md"
  }
}
```

**Standalone reviews** (`/fly:review` invoked on a PR without a preceding planned session): create a review-only session `sessions/review-pr-<number>-<YYYY-MM-DD>/` with just `review.findings.json` + `session.json`. Uniform structure means `/fly:work` on the review's findings.json works the same as on a planned session's findings.json.

### Editability model

`spec.json` is the user-editable artifact. It's readable JSON (summary field on top, phases with clear titles, tasks as bullet-shaped objects). Users can:

- **Edit spec.json directly** — small adjustments (rename a task, add a file path, tweak verification command). Fast for tactical changes.
- **Re-run plan-creation** with a sharper prompt — regenerates spec.json from scratch with new direction. Appropriate when the approach needs to change.
- **Run plan-review + plan-consolidation** — formal refinement via reviewer findings + interactive Open Questions. Appropriate when the user wants external perspective.

No prose-parsing boundary anywhere in the pipeline. When spec.json is written by a skill, it's written from structured state in memory; when it's refined by consolidation, findings.json provides structured input.

### Why this works

- **Structured from stage 1**: plan-creation's output is work-ready. Skip-review becomes a single-skill workflow (`plan-creation → work`), matching the user's common usage pattern.
- **Session-scoped artifacts are gitignored**: `.flywheel/plugin/sessions/<id>/` clusters all in-flight work for one session. Durable team knowledge (standards, solutions, research) stays in `docs/`. No accidental commits of WIP state.
- **O(1) session resume**: active pointer at `.flywheel/plugin/active.json` means no filesystem scans on `/fly:work` invocations. Multi-session support is free (just create more dirs) without performance cost to resume.
- **Rigor increases through refinement**: review adds findings; consolidation resolves questions and merges them back into spec.json. Each refinement pass makes the spec more precise without changing its shape.
- **Each JSON artifact has a stable schema**: no transient keys. spec.json looks the same whether it's freshly drafted or post-consolidation. findings.json is always the same shape.
- **Single writer per file** (with one deliberate exception): findings.json, baseline.json, state.json, review.findings.json — one writer each. spec.json has two writers (plan-creation drafts it, plan-consolidation refines it); the writer history is captured by the file's content at any point.
- **Machine handoffs stay machine-format**: JSON at every stage transition.
- **Schemas are first-class artifacts**: `flywheel/schemas/*.schema.json` are the single source of truth; SKILL.md files reference them rather than restate. No producer/consumer drift.
- **Every artifact is versioned and self-describing**: `schema_version: 1` + required `summary` field on every JSON artifact.
- **work-implementation has one input contract** (`TaskList`): both `spec.json` and `findings.json` deserialize into it.
- **Assertion-level traceability**: `behavioral_contract[]` + per-task `fulfills[]` makes "did we build what we said we'd build?" a mechanical check at consolidation (every BC claimed) and at review (every BC has evidence).
- **Commands are re-verifiable**: `state.phases[].artifacts.commands_run` records exit codes; work-review spot-checks by re-executing. "Tests passed" becomes evidence, not claim.
- **Research anchors the spec**: plan-creation's locate-then-analyze pattern (Flywheel's existing win) stays — it just writes JSON conforming to the K2 schema instead of MINIMAL/MORE/A LOT markdown templates.

---

## Architecture Changes (K1–K6)

The six structural changes that realize the rigor gradient. All six are mutually dependent — the pipeline only works when they land together.

### K1. Reviewer output becomes JSON (two-tier artifact)

**Files**: all 6 `agents/reviewer-*.md` (Output Format section); synthesizer logic in `skills/work-review/SKILL.md` Phase 3 and `skills/plan-review/SKILL.md` Phase 3.

**Current**: reviewers return a task-shaped markdown report. Synthesizer regex-parses prose.

**Change**: each reviewer returns a single JSON object. Findings carry a polymorphic `scope` field because plan-review findings locate against plan structure (phase/task/BC) while work-review findings locate against code (file/line):

```json
{
  "schema_version": 1,
  "reviewer": "reviewer-architecture",
  "summary": "<100–5000 char natural-language summary of what this reviewer found>",
  "findings": [
    {
      "title": "<one-line>",
      "severity": "P1" | "P2" | "P3",
      "scope": {
        "kind": "code",
        "file": "<repo-relative path>",
        "line": <number or null>
      },
      "what_wrong": "<observable behavior — what breaks, for whom (anticipated for plan findings)>",
      "suggested_fix": "<concrete change, or 'see discussion'>",
      "evidence": "<quote or file:line reference, or spec.json path>"
    }
  ],
  "residual_risks": [],
  "open_questions": []
}
```

For plan-review findings, `scope` takes the plan-structure form:
```json
"scope": {
  "kind": "plan",
  "phase_id": "phase-2",   // or null for plan-level findings
  "task_id": "t3",          // or null for phase-level findings
  "bc_id": "BC-AUTH-001"    // or null for findings not tied to a specific BC
}
```

All top-level keys required. Within `scope`, `kind` is required; other fields are contextual (`line` nullable for file-level code findings; any of phase/task/bc nullable for plan findings). Return valid JSON only.

**Schema as first-class artifact**: the authoritative definition lives in `flywheel/schemas/findings.schema.json` (JSON Schema). All 6 reviewer agent prompts and both synthesizer SKILL.md files reference it rather than restating. This matches the TUI's `WorkerHandoff` pattern where schemas are the single source of truth and prompt examples are rendered from them — eliminates producer/consumer drift.

**Required fields on every machine artifact** (adopted from TUI `HandoffFieldSpec` discipline):
- `schema_version: 1` — enables non-breaking evolution; consumers can reject unsupported versions explicitly rather than silently misparsing.
- `summary` (100–5000 chars) — natural-language description of what the reviewer produced. Makes the artifact self-describing when a human reads it without deserializing. Matches TUI's required `summary` field on every handoff.

**Handoff pattern**: reviewer JSON inline as Task result → synthesizer merges and writes into the active session's artifact (`findings.json` for plan-review, `review.findings.json` for work-review). At end of the skill, the agent prints a natural-language summary to chat — the same content as the JSON's `summary` field. No separate markdown artifact; the JSON is self-describing and the chat summary is ephemeral-by-design. If a user wants to re-read later, the session's findings JSON is human-readable and includes the `summary` field up top.

**Why**: synthesis code becomes array operations (`findings.filter(f => f.severity === 'P1')`, `groupBy(f => f.scope.kind === 'code' ? f.scope.file : f.scope.phase_id)`, `new Set(findings.map(fingerprint))`) instead of regex parsers. Polymorphic `scope` means the same synthesizer handles both plan and code findings with one branch at the grouping step. Over 6 reviewers × 10–20 findings: ~10–12k tokens saved at handoff per review. Dropping the dual-write (JSON + rendered md) also removes the drift risk and extra write cost.

**Enables**: K2 spec schema (findings deserialize into TaskList), A1 fingerprint dedup, B2/B3 content rules applied at field level.

---

### K2. Spec schema (`TaskList`) — shared contract with behavioral traceability

**Files**: new `flywheel/schemas/task-list.schema.json` (JSON Schema, authoritative); referenced by `plan-consolidation`, `work-implementation`, and `work-review`. Companion schemas: `findings.schema.json` (K1), `state.schema.json` (K5), `baseline.schema.json` (K6), `session.schema.json` (session metadata — see Session Lifecycle).

**Current**: no shared contract. Plans are md templates; findings are markdown bullets; work-implementation parses both differently.

**Change**: one JSON schema describing the shape that `plan-consolidation` emits and that `work-implementation` consumes. Also the shape `work-review` findings deserialize into for the "apply fixes" flow. Adopts the TUI's `behavioralContract[]` + `fulfills[]` pattern for assertion-level traceability.

```json
{
  "schema_version": 1,
  "plan_id": "<slug>",
  "summary": "<100–5000 char natural-language description of the plan>",
  "goal": "<one-paragraph>",
  "origin": { "created_by": "plan-creation | plan-consolidation", "findings_path": "findings.json | null" },
  "context": {
    "key_files": [{ "path": "...", "why": "..." }],
    "patterns": [{ "name": "...", "reference": "file:line" }],
    "gotchas": ["..."]
  },
  "behavioral_contract": [
    {
      "id": "BC-AUTH-001",
      "title": "<short>",
      "description": "<pass/fail-testable>",
      "evidence": "<how to verify>",
      "area": "<functional area>"
    }
  ],
  "phases": [
    {
      "id": "phase-1",
      "goal": "<phase outcome>",
      "depends_on": [],
      "files": ["<repo-relative paths>"],
      "tasks": [
        {
          "id": "t1",
          "description": "<what to do>",
          "files": ["..."],
          "test_scenarios": [{ "name": "...", "expects": "..." }],
          "fulfills": ["BC-AUTH-001", "BC-SESSION-003"]
        }
      ],
      "verification": "<command, e.g. 'bun run test path/to/test'>",
      "manual_verification": null
    }
  ],
  "success_criteria": ["..."]
}
```

**Behavioral contract semantics** (adopted from TUI `src-legacy/queue/steps/plan-draft/prompts.ts`):
- Each BC is a pass/fail-testable assertion with a stable ID (`BC-<AREA>-<NNN>`).
- Every BC **must be claimed by exactly one task** via `fulfills[]`. Orphaned BCs (claimed by zero tasks) or duplicated BCs (claimed by multiple) are validation errors at consolidation time (K4 step 6a).
- Work-review uses the contract as a coverage check at implementation time: every BC must have evidence in the diff.

**Adapter from findings** (fix-findings mode): when generated from `<slug>.findings.json`, each phase groups findings sharing a file/subsystem; each task is one finding's `suggested_fix` with `files` from the finding's `file` and `test_scenarios` derived from `what_wrong`. Behavioral contract can be either carried from a parent plan's spec.json (if this is a fix pass on an existing plan) or synthesized from finding titles (if it's a standalone review implementation).

**Why**: one schema, one executor, one traceability substrate. No branching in work-implementation on input type. BC IDs turn `success_criteria` from a flat list into a claim graph — each assertion is owned by a specific task, each task declares which assertions it satisfies. Coverage becomes computable (not prose).

---

### K3. plan-creation emits `spec.json` directly

**Files**: `skills/plan-creation/SKILL.md` — rewrite output phase. Remove MINIMAL/MORE/A LOT template variants in `references/`.

**Current**: plan-creation Phase 3 picks between MINIMAL/MORE/A LOT templates; Phase 4 writes a fully-structured markdown plan with file:line references, test-first phase ordering, Single Responsibility per phase.

**Change**: plan-creation keeps the same research pipeline (Phase 0 existing-knowledge check, Phase 1 locate-then-analyze, Phase 2 external validation via Context7). The output phase changes from "write templated markdown" to "create session + compose `spec.json` conforming to the K2 schema."

**Output procedure**:

1. Derive session ID from the feature slug + today's date (`<slug>-<YYYY-MM-DD>`). Create session directory at `.flywheel/plugin/sessions/<session-id>/`.
2. From research outputs, synthesize phases + tasks (same logical work the current MINIMAL/MORE/A LOT templates require — just committed to JSON).
3. Assign concrete file paths (the locator-then-analyzer research already surfaced these).
4. Enumerate test scenarios per task, specific enough that the implementer doesn't invent coverage.
5. Compose `behavioral_contract[]`: extract pass/fail-testable assertions from the user's feature request + research-derived success signals. Assign stable `BC-<AREA>-<NNN>` IDs. Each task gets a `fulfills[]` array pointing at the BCs it satisfies.
6. Apply B4 quality bar + BC coverage validation (see K4 step 6 — same gate, applied here since plan-creation is now a spec producer).
7. Write `spec.json` within the session dir, conforming to K2 schema with `schema_version: 1`, top-level `summary` (100–5000 chars), and full `behavioral_contract[]`.
8. Write `context.md` sidecar in the session dir (research findings) — unchanged content from current, just new location.
9. Write `session.json` with status: active, artifact pointers, timestamps.
10. Update `.flywheel/plugin/active.json` to point at this session.
11. Print summary to chat. Prompt: "Run `/fly:review` for refinement, or proceed to `/fly:work`?"

**Why**: matches the user's common workflow pattern (plan → work, skip review). spec.json from plan-creation is rigorous enough to execute against. Review and consolidation remain available as refinement passes when the user wants external perspective. The shift in plan-creation is format (md-templated → JSON-structured), not additional work — it's already synthesizing phases, files, test scenarios, and success criteria under the current templates. Emitting JSON conforming to the shared schema means the output interoperates with work-implementation directly and flows through the same refinement pipeline as a reviewed plan.

**Why the rigor gradient is preserved**: rigor still increases through stages — plan-creation produces a best-effort spec; plan-review interrogates it; plan-consolidation refines it with findings and user decisions. The gradient is rooted at a structured stage 1 rather than a loose one, which matches how specs evolve in practice (draft → feedback → revised draft).

**Note on B4 (plan quality bar)**: applies at both plan-creation output and plan-consolidation output. Same gate, two invocation points. If plan-creation can't pass the bar (unresolved uncertainty about files / test scenarios), it surfaces that as an `open_question` in the spec rather than a vague task, and flags to the user that review+consolidation will likely be needed.

---

### K4. plan-consolidation merges findings into `spec.json`

**Files**: `skills/plan-consolidation/SKILL.md` — rewrite. `references/consolidated-plan-template.md` replaced by a JSON refinement procedure.

**Current**: plan-consolidation reads a plan md (with Review Summary already appended by plan-review) → resolves Open Questions → writes a consolidated md with integrated checklist.

**Change**: plan-consolidation becomes the **refinement** stage (not composition — plan-creation composes). Only runs when findings exist to integrate.

**Inputs**: the active session's `spec.json` + `findings.json` + `context.md` (if present). Paths are relative to `.flywheel/plugin/sessions/<active-session-id>/`.

**Procedure**:
1. Read all three inputs.
2. Surface unresolved Open Questions from `findings.json.open_questions` and inter-reviewer conflicts (fingerprint matches with diverging severities). Present interactively, one at a time.
3. For each P1 finding, decide placement: integrate the `suggested_fix` into the relevant task's `description` + add to `test_scenarios` if applicable. P1 findings that don't map to existing tasks introduce new tasks (and potentially new BCs).
4. For each P2 finding, same but user can defer with rationale (recorded as a note in the task description).
5. For each P3 finding, user triage: include or drop entirely. Dropped P3s don't persist (per current Flywheel convention).
6. If new tasks were added, compose any missing `fulfills[]` claims or new BCs. Re-validate coverage:
   - Every phase still has concrete file paths, test scenarios, verification, success criteria.
   - **Every BC is claimed by exactly one task.** Orphans loop back; duplicates collapse; unclaimed findings → add BC + task or drop with rationale.
7. Update `spec.json`: write the refined version (same file path, overwrites). Increment a `revision` field if we want changelog (see open question). Update top-level `summary`.
8. Print summary to chat (what was refined, which Open Questions resolved, which findings integrated vs deferred). Prompt: "Start `/fly:work`?"

**Why**: with plan-creation now emitting a structured spec.json, consolidation's job is purely to fold review-derived information back into the spec. This is simpler than "compose from scratch" because the structure already exists — consolidation is a targeted merge, not a full synthesis. Interactive effort is spent where it matters (resolving Open Questions, triaging P3s), not on re-composing what plan-creation already produced.

**If findings.json has zero findings and zero open questions** (rare — pristine plan): consolidation is a no-op and prints "no refinements needed" then prompts for work. User can also skip consolidation entirely in this case.

---

### K5. work-implementation consumes `TaskList`

**Files**: `skills/work-implementation/SKILL.md` — rewrite Phase 1 (Load & Resume); adapters in `references/`.

**Current**: reads a plan md; Phase 1 derives `<plan>.state.md` path; parses plan structure from md.

**Change**: work-implementation resolves the active session via `.flywheel/plugin/active.json` (no args) or `$ARGUMENTS` (session slug or path to a findings.json for fix-findings mode). Phase 1:

1. Resolve target session. No args → read `active.json`, load session dir. Slug arg → prefix-scan `sessions/<slug>-*`, promote to active. Findings.json path arg → use review-only session containing that findings.json.
2. Detect input type within the session (spec.json present → plan mode; review.findings.json only → fix-findings mode).
3. Load appropriate adapter:
   - spec.json → direct deserialize into `TaskList`.
   - findings.json → adapter groups findings into phases (by file/subsystem), converts each finding to a task, synthesizes a `TaskList`.
4. Write `baseline.json` in the session dir (snapshot of the `TaskList` at work-start).
5. Write `state.json` in the session dir (initialized — all phases `not_started`).
6. Update `session.json` with `active_skill: "work-implementation"` and checkpoint timestamp.
7. Proceed to Phase 2 execution loop, iterating over `TaskList.phases`.

State file schema (`state.json`):
```json
{
  "schema_version": 1,
  "plan_id": "...",
  "status": "in_progress" | "completed",
  "summary": "<short — updated per checkpoint; what's done, what's next>",
  "phases": [
    {
      "id": "phase-1",
      "status": "not_started" | "in_progress" | "awaiting_manual" | "complete",
      "started_at": "...",
      "completed_at": "...",
      "outcomes": "...",
      "strikes": [],
      "bc_satisfied": ["BC-AUTH-001"],
      "artifacts": {
        "files_created": ["src/auth.ts"],
        "files_modified": ["src/app.ts"],
        "commands_run": [
          { "command": "bun run test src/auth.test.ts", "exit_code": 0, "stdout_tail": "12/12 tests pass" }
        ]
      }
    }
  ],
  "learnings": [],
  "error_log": []
}
```

Phase 2 execution loop reads/writes state.json as structured data. No markdown checkbox parsing. Every phase completion records the concrete commands run and files changed — this is the substrate for K6's re-verification spot-check.

**Accuracy requirement** (adopted from TUI `WORK_STEP_FIELDS`): `commands_run` entries are subject to re-execution by work-review. Fabricated or inaccurate entries (wrong exit code, non-existent file) fail compliance and trigger a retry. Only record commands actually executed and files actually on disk.

**Why**: one execution loop, one in-memory contract, one state format. The skill becomes simpler, not more complex — the two input formats are absorbed at the adapter layer, leaving the execution logic uniform. Structured `artifacts` + `commands_run` per phase make the "did work-implementation actually do what it claimed" question mechanically answerable rather than trust-based.

---

### K6. Baseline and state become JSON (with re-verification)

**Files**: `skills/work-implementation/references/state-file-template.md`, `references/baseline-procedure.md`; `skills/work-review/SKILL.md` Phase 1.0 (plan compliance check).

**Current**: `<plan>.state.md` tracks phase completion via markdown checkboxes; `<plan>.baseline.md` is a markdown snapshot. Both live in `docs/plans/`.

**Change**: both become JSON. `baseline.json` is a frozen copy of `spec.json` at work-start (`schema_version: 1`, includes full `behavioral_contract[]` and `phases[].tasks[].fulfills[]`). `state.json` follows the K5 schema with `artifacts` + `commands_run` per phase.

**Baseline is read-only after work-start** (adopted from TUI's `DO NOT MODIFY` discipline in `plan-review` scaffolding). work-implementation must not mutate baseline.json. Any evolution of the plan mid-execution requires explicit re-planning: user edits spec.json directly (or re-runs plan-creation / plan-consolidation), then re-invokes work-implementation — which writes a fresh baseline.json from the new spec. This keeps compliance comparison honest: the baseline is what was committed to, not what it became.

**Plan compliance check in work-review Phase 1.0** becomes three mechanical checks, each emitting findings in the K1 JSON format:

1. **Structured diff**: `diff(baseline.phases, state.phases)` for skipped phases, removed tasks, files changed outside `baseline.phases[].files`. Deviations → P1 findings.
2. **BC coverage**: every `baseline.behavioral_contract[].id` must appear in the union of `state.phases[].bc_satisfied[]`. Uncovered BCs → P1 findings. (This is the implementation-side mirror of K4 step 6's planning-side BC coverage check.)
3. **Commands re-execution spot-check** (adopted from TUI `WORK_STEP_FIELDS` + verification agent): sample the last N `commands_run` entries from `state.phases[]` (default 3, or all if fewer), re-execute, compare exit codes. Mismatches → P1 finding. Missing files claimed in `artifacts.files_created`/`files_modified` → P1 finding.

**Why**: structured compliance is more reliable than md diff (no whitespace false positives). BC coverage turns the "did we build what we said we'd build?" question into a mechanical check. Commands re-execution prevents the "tests passed on my machine" failure mode — the plan's B5 anti-pattern ("declare done without running tests") becomes mechanically enforced rather than just a directive. All three checks emit findings in the K1 schema, so they flow through the same dedup (A1) and rendering (B3) pipeline as other reviewer findings.

---

## Tier A — Direct Code-Output Elegance (CE adoptions on top of the architecture)

These apply *in addition* to the architecture changes. They sharpen reviewer quality and reduce noise at the finding-content level. Ordering retained from original research filter.

### A3. Method-embedded reviewer openers

**Files**: All 6 `agents/reviewer-*.md` (opener paragraph).

**Change**: replace role-framing openers with method instructions.

| Agent | New opener |
|---|---|
| `reviewer-architecture` | "You are an architecture reviewer who traces dependency direction, state ownership, and abstraction layer boundaries. You spot layering violations and circular imports by mentally mapping the module graph." |
| `reviewer-code-quality` | "You read code for type safety, readability, and idiom adherence. You ask: 'will a maintainer six months from now understand this in 30 seconds?' You flag cleverness that obscures intent." |
| `reviewer-elegance` | "You review for design simplicity — fewer moving parts, less state, shorter call chains. You ask: 'is there a version of this with half the complexity that serves the same need?' You flag accidental complexity, not essential complexity." |
| `reviewer-performance` | "You trace hot paths, allocation patterns, and I/O boundaries. You ask: 'at what scale does this break?' You flag O(n²) where O(n) fits, N+1 queries, and blocking calls in async paths." |
| `reviewer-patterns` | "You read the surrounding codebase first, then the diff. You ask: 'does this match how the rest of the codebase solves similar problems?' You flag local reinventions of existing utilities and convention breaks." |
| `reviewer-data-integrity` | "You check migration safety, transaction boundaries, referential integrity, and rollback behavior. You ask: 'what breaks if this fails halfway through?'" |

**Why**: each opener teaches the reviewer what *kind* of inelegance to look for. Method-primed reviewers catch more real issues → implementer fixes → ships cleaner code. `reviewer-elegance` and `reviewer-patterns` are the two reviewers most directly concerned with elegance; sharpening their primers has outsized downstream effect.

**Tokens**: zero (same length).

---

### B2. False-positive suppression catalog

**Files**: `skills/flywheel-conventions/SKILL.md` (add after Output Rules).

**Change**:
```markdown
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
```

**Why**: breaks the dominant inelegance-producing feedback loop — *reviewer emits speculative "consider adding X" → implementer adds X the code doesn't need → ceremony accretes*. Every suppressed false positive is one fewer needless branch, wrapper, or helper in shipped code.

**Tokens**: +~12 lines, loaded once via `skills: [flywheel-conventions]`. Saves tokens on every review because findings emitted are fewer.

---

### B3. Observable-behavior framing for finding content

**Files**: `skills/flywheel-conventions/SKILL.md` (after B2).

**Change**:
```markdown
## Finding Quality: Lead with Observable Behavior

For every finding, the `what_wrong` field must lead with what breaks, for whom — not with code or plan structure.

**Code findings** (scope: code) — describe what breaks NOW:

- **Weak**: "The function parseDate() doesn't validate input format."
- **Strong**: "Users submitting dates in DD/MM/YYYY hit a silent parse error that logs them out. parseDate only accepts YYYY-MM-DD and returns null; the caller doesn't check."

**Plan findings** (scope: plan) — describe what WILL break when the plan is implemented:

- **Weak**: "Phase 2 doesn't specify error handling."
- **Strong**: "When the network request in Phase 2 fails, users will see a crash. The plan doesn't specify fallback UI or retry logic, and BC-AUTH-003 ('graceful network failure') has no task claim."

If you cannot name a concrete observable consequence — present or anticipated (wrong result, unhandled error, contract mismatch, security exposure) — the finding is advisory. Mark it P3 or suppress.
```

**Why**: observable-behavior framing constrains the fix. "parseDate doesn't validate" invites scattershot fixes; "users in DD/MM/YYYY hit a silent parse error" invites a surgical fix at the exact boundary. Pairs directly with B2 — a finding that cannot name what breaks is exactly the kind of "consider adding" noise that leads to ceremony fixes.

**Tokens**: +~8 lines. Net negative in practice — speculation findings get suppressed.

---

### B4. Plan quality bar (now in plan-consolidation, not plan-creation)

**Files**: `skills/plan-consolidation/SKILL.md` — add between K4 step 5 and step 6.

**Change**:
```markdown
## Spec Quality Bar

Before emitting `spec.json`, verify each phase contains:

- Clear goal and success criterion
- Repo-relative file paths (never absolute)
- Enumerated test scenarios specific enough that the implementer doesn't invent coverage
- Explicit verification command
- Clear dependencies (`depends_on`) if any

A spec is ready when an implementer can start confidently without needing to infer.

If any phase fails the bar, loop back: read the codebase, ask the user, or defer the phase explicitly as `status: deferred` with rationale.
```

**Why**: the spec is the executable contract. If phases have vague files / missing test scenarios / undefined verification, the implementer invents → produces code anchored to invented tests rather than real behavior. The quality bar stops invention at the source.

**Tokens**: +~12 lines in consolidation. Saves more on re-work cycles when under-specified plans would otherwise cascade.

---

### B5. Specific anti-patterns for `work-implementation`

**Files**: `skills/work-implementation/SKILL.md` (anti-patterns section).

**Change**: append three concrete anti-patterns:
```markdown
- **Split plan into "this session" phases** — agents execute at agent speed; context pressure is handled via Ralph mode or subagent dispatch, not human-time session breaks. If a spec is genuinely too large, say so and return to plan-consolidation to reduce scope.
- **Ask for approval between every task** — the spec is the authority; do not renegotiate scope mid-execution. Only ask when the spec itself is ambiguous (missing field, empty test_scenarios, etc.).
- **Declare "done" without running tests** — `references/verification-gates.md` requires evidence, not claims. Each phase's `verification` command must execute and pass before state transitions to `complete`.
```

**Why**: "ask for approval between every task" produces partial, half-integrated work. "Declare done without running tests" ships untested code. Both are process failure modes whose symptom is code less complete than claimed.

**Tokens**: +~5 lines. Saves more by preventing re-work cycles.

---

### B6. System-Wide Test Check (late-loaded)

**Files**: `skills/work-implementation/references/verification-gates.md` (append).

**Change**: 5-question integration-bug catalog:
- What fires when this runs? (callbacks, middleware, observers)
- Do tests exercise the real chain, or is everything mocked?
- Can failure leave orphaned state?
- What other interfaces expose this?
- Do error strategies align across layers?

**Why**: surfaces integration bugs → implementer fixes at the right layer, not every layer. One well-placed handler beats five defensive wrappers. Directly reduces ceremony in shipped code.

**Tokens**: +~15 lines, loaded only on the verification path (not every work-implementation invocation).

---

### A1. Fingerprint-based dedup for findings (now operates on JSON)

**Files**: synthesizer logic in `skills/plan-review/SKILL.md` Phase 3, `skills/work-review/SKILL.md` Phase 3.

**Depends on**: K1 (findings are JSON with typed fields, polymorphic `scope`).

**Change**: deterministic fingerprint, adapted per scope kind:

- **Code findings** (`scope.kind === "code"`): `code:${scope.file}:${Math.floor(scope.line / 7)}:${normalize(title)}` — line-bucket of 7 so `file.ts:42` and `file.ts:44` collide.
- **Plan findings** (`scope.kind === "plan"`): `plan:${scope.phase_id ?? '*'}:${scope.task_id ?? '*'}:${scope.bc_id ?? '*'}:${normalize(title)}` — findings targeting the same phase/task/BC with similar titles collide.

Pure `Set` operation over parsed JSON — no regex, no string parsing. Cross-reviewer matches on the same fingerprint promote severity by one level.

**Why**: three overlapping findings from different reviewers become one deduplicated finding. User sees unique issues; implementer fixes each once rather than three times with layered ceremony. Polymorphic fingerprinting means the same dedup logic applies uniformly to both plan-review and work-review outputs — no duplicated code path for the two review types.

**Tokens**: zero model cost (pure set operation).

---

## Tier B — Token Wins with Limited Code-Output Impact (skill hygiene)

Worth doing for token efficiency; not primary elegance levers on agent output.

### B1. Rationale discipline rule + late-sequence extraction audit

**Files**: `skills/flywheel-conventions/SKILL.md` (add rule); audit `work-implementation/SKILL.md`, `plan-consolidation/SKILL.md`, and `plan-creation/SKILL.md` after K3/K4/K5 land.

**Rule**:
```markdown
## Rationale Discipline

Every line in a SKILL.md loads on every invocation. Include rationale only when it changes what the agent does at runtime. If behavior would not differ without the sentence, cut it. Extract conditional/late-sequence content to `references/` and load on demand.
```

**Impact**: near-zero on code output. 15–20% reduction in SKILL.md load per `plan-creation` / `work-implementation` / `plan-consolidation` invocation.

---

### A2. Severity behavioral criteria

**Files**: `skills/flywheel-conventions/SKILL.md:25`.

**Change**:
```
- P1: High-impact defect — security, data loss, breaking change, or likely hit in normal usage. BLOCKS MERGE.
- P2: Moderate issue with real downside (edge case, perf regression, maintainability trap). Fix if straightforward.
- P3: Low-impact, narrow scope. User's discretion.
```

**Impact**: sharper prioritization. Tokens: zero.

---

### A4. BLOCKING prefix discipline audit

**Files**: all SKILL.md files.

**Change**: audit every "Do NOT X" / "Must X" directive. If it is a gate, prefix `**BLOCKING:**`. Otherwise plain bold.

**Impact**: marginal on agent behavior; zero tokens.

---

### A5. Core principles numbered list

**Files**: `skills/plan-creation/SKILL.md:17-21` (replaces current Philosophy/Context Compaction).

**Change**:
```markdown
## Core Principles

1. **Codebase reality first** — ground the spec in what the codebase actually does. Dispatch locators before hypothesizing patterns.
2. **Decisions, not code** — capture approach, boundaries, risks, test scenarios. Do not pre-write implementation code.
3. **Executable-from-day-one** — the spec.json you write is work-implementation-ready. If you can't commit to concrete file paths or test scenarios for a task, surface it as an `open_question` on the spec rather than a vague task.
4. **Separate planning from execution discovery** — surface what's unknown as `open_questions`; plan-review and plan-consolidation exist to resolve them when review is invoked.
5. **Validate high-risk claims** — security, payments, crypto, migrations, privacy trigger external validation via Context7.
```

**Impact**: indirect (referenceable principles, clearer stage boundaries). Tokens: ~same as current Philosophy/Context Compaction.

---

### B7. Skill description negative routing

**Files**: descriptions in `plan-creation`, `brainstorm`, `work-implementation`, `debug`.

**Change**: append short "when NOT to invoke" hints. Example for `plan-creation`:
> "For exploratory requests where the user is unsure what to build, prefer brainstorm first. Once spec.json exists, use plan-review for evaluation or go straight to work. For a reviewed spec, use plan-consolidation to merge findings."

**Impact**: reduces mis-invocation. Tokens: +~25 per description at selection time.

---

### B8. Discoverability check in `compound`

**Files**: `skills/compound/SKILL.md` — Step 2.5.

**Change**: on first compound creation per repo (detected by: `docs/solutions/` has <3 files, or AGENTS.md/CLAUDE.md has no grep hit for "docs/solutions"), offer to add a one-line reference to AGENTS.md. One `AskUserQuestion`, one conditional `Edit`.

**Impact**: self-maintaining knowledge-store discovery. Future agents find and reuse prior fixes. Tokens: ~100 one-time per repo.

---

## Rejected

### R1. Tracker-defer for P3 findings
No code-output impact. Moves dropped P3s to GitHub issues; adds `gh` coupling and Linear fallback chain. If problem bites, write a local `.flywheel/plugin/sessions/<id>/deferred.findings.json` instead.

### R2. Diff-size threshold for reviewer dispatch
Violates Flywheel's predictability invariant. Token savings real but conditional dispatch makes `work-review` hard to reason about. The right lever for review cost is tighter reviewer prompts (Tier A items), not dispatch rules.

### R3. Lightweight confidence marker on findings
Adds a per-finding field for tokens. B3 (observable-behavior framing) already suppresses speculation. Redundant.

### R4. Optional "deepen" pass in `plan-review`
Adds conditional re-review surface. A3 (method-embedded openers) achieves more by sharpening the first pass.

### R5. Auto-memory integration in `compound`
Claude-Code-specific platform coupling for marginal gain.

### R6. Per-reviewer intent verification
Redundant with plan compliance check (K6, now structured via baseline.json). Duplicating across reviewers is the inelegant version.

### R7. Research Tier 3 items (validator subagents, 18-persona catalog, `ce-compound-refresh`, HITL Proof, `ce-ideate`, `lfg`, multi-platform conversion, `ce-agent-native-audit`, Codex delegation, dedicated `ce-worktree` skill)
Research already rejected these; elegance-of-output filter agrees.

---

## Implementation Sequence

Ordered by dependency. Architecture changes (K1–K6) land as a cohesive unit; CE adoptions layer on.

### Phase 1 — Shared Conventions + Schemas + Storage (foundation)

1. **Storage** Add `.flywheel/` to `.gitignore`. Create `.flywheel/plugin/` structure stubs (`sessions/`, `traces/`, `log/`) or document that skills will mkdir on first use.
2. **K2** Author the authoritative JSON Schemas in `flywheel/schemas/`: `findings.schema.json`, `task-list.schema.json`, `state.schema.json`, `baseline.schema.json`, `session.schema.json`. Each with `schema_version: 1` and `summary` required (where applicable). Include `behavioral_contract` + `fulfills` in `task-list.schema.json`. Findings schema includes polymorphic `scope` (code vs plan).
3. **B2** False-positive suppression catalog → `flywheel-conventions`.
4. **B3** Observable-behavior framing → `flywheel-conventions`.
5. **A2** Severity behavioral criteria → `flywheel-conventions:25`.

All reviewers inherit conventions via `skills: [flywheel-conventions]`. Producers and consumers of JSON artifacts reference the schemas by path rather than restating their shape.

### Phase 2 — Reviewer Boundary (enables findings.json)

5. **K1** Findings-shaped JSON Output Format in all 6 `reviewer-*.md`.
6. **A3** Method-embedded openers in all 6 `reviewer-*.md`.
7. **A1** Fingerprint dedup in `plan-review` / `work-review` synthesis; write session's `findings.json` (plan-review) or `review.findings.json` (work-review).

Verification: run a review on a known-noisy branch. Findings should emit clean JSON; dedup should collapse cross-reviewer overlaps; rendered md review doc should be cleaner than before.

### Phase 3 — Planning Pipeline (structured-from-stage-1)

8. **K3** Rewrite `plan-creation` to create a session directory and emit `spec.json` conforming to K2 schema. Drop MINIMAL/MORE/A LOT templates. Update `.flywheel/plugin/active.json`. Same research pipeline, JSON output.
9. **B4** Spec quality bar + BC coverage validation applied at plan-creation output (step 5 of K3).
10. **A5** Updated core principles in plan-creation.
11. **K4** Rewrite `plan-consolidation` as a refinement pass: reads spec.json + findings.json → resolves Open Questions → writes refined spec.json.

Verification: run `/fly:plan` (plan-creation alone) and confirm spec.json is work-implementation-ready without requiring consolidation. Run full pipeline (creation → review → consolidation) and confirm findings integrate cleanly into the refined spec.

### Phase 4 — Execution Boundary

12. **K5** Rewrite `work-implementation` Phase 1: accept `spec.json` or `findings.json`; load via adapter; deserialize to `TaskList`. Phase 2 execution records `artifacts.commands_run` per phase with accurate exit codes.
13. **K6** Migrate state + baseline to JSON. Baseline read-only after work-start. Compliance check in `work-review` Phase 1.0 runs three mechanical checks: structured diff, BC coverage, commands re-execution spot-check.

Verification: run `/fly:plan` + `/fly:work` + `/fly:review` on a real feature. Skip-review path works (plan-creation → work). Full path works. Baseline comparison catches injected scope drift. Commands re-execution catches injected false exit codes.

### Phase 5 — Execution Quality (work-implementation enhancements)

14. **B5** Specific anti-patterns in `work-implementation/SKILL.md`.
15. **B6** System-Wide Test Check in `verification-gates.md`.

### Phase 6 — Skill Hygiene (token wins)

16. **B1** Rationale discipline rule + extraction audit on `work-implementation`, `plan-consolidation`, `plan-creation`.
17. **A4** BLOCKING prefix audit across all SKILL.md files.
18. **B7** Negative routing on 4 skill descriptions.
19. **B8** Discoverability Step 2.5 in `compound/SKILL.md`.

---

## Expected Impact

### Code the agent ships

- **Smaller PR diffs**: FP suppression (B2) prevents reviewer noise → implementer doesn't add ceremony to "fix" it.
- **Surgical fixes**: observable-behavior framing (B3) anchors findings to specific breakages → implementer fixes the boundary, not defensively refactors.
- **Fewer defensive wrappers**: system-wide test check (B6) reorients toward the right layer → one handler, not five.
- **Tests that anchor to behavior**: spec quality bar (B4) enforces enumerated test scenarios → no invented coverage.
- **Single root-cause fix per issue**: fingerprint dedup (A1) prevents 3 overlapping findings from becoming 3 overlapping fixes.
- **Better accidental-complexity detection**: method-embedded `reviewer-elegance` (A3) asks "is there a version of this with half the complexity" at the point of review.
- **Complete, tested work**: anti-patterns (B5) stop "done without tests" and "approval between every task" failure modes.
- **Compliance-verified implementation**: structured baseline comparison (K6) catches scope drift without false positives.
- **No silent coverage gaps**: BC coverage validation (K4 step 6, K6 check 2) ensures every planned assertion is claimed by exactly one task at planning time *and* has evidence at review time. Drift between "what we said we'd build" and "what we built" becomes mechanical, not prose-judged.
- **No false "done" claims**: commands re-execution spot-check (K6 check 3) re-runs a sample of claimed `commands_run`. "Tests passed on my machine" fails verification when the exit codes don't match — implementer must fix and resubmit rather than ship on trust.

### Tokens per session

- **Reviewer output**: ~60–80 tokens per finding (JSON) vs ~150–180 (markdown labels). 6 reviewers × 10–20 findings ≈ 10–12k tokens saved per review.
- **Fewer findings**: B2 + B3 suppress speculation.
- **No prose parsing anywhere**: each handoff is structured. Synthesizers do array operations, not regex.
- **Skip-review workflow is single-skill**: plan-creation → work. No mandatory consolidation step for users confident in their spec. Saves the consolidation round trip entirely on the common path.
- **SKILL.md hygiene** (B1 audit): 15–20% reduction per `work-implementation` / `plan-consolidation` invocation.

### Pipeline properties

- **Structured from stage 1**: plan-creation's output is work-ready. Skip-review becomes single-skill.
- **Rigor increases via refinement**: review adds findings; consolidation merges them. Each pass makes spec more precise, schema stays stable.
- **Single writer per file** (with one deliberate exception — spec.json, drafted by plan-creation and refined by plan-consolidation). Baseline is read-only after work-start.
- **User editability is JSON**: spec.json is readable and hand-editable for small tweaks; re-run plan-creation for larger direction changes.
- **Uniform executor input**: work-implementation reads `TaskList` regardless of source (spec.json or findings.json).
- **Schema is the source of truth**: producers and consumers reference `flywheel/schemas/*.schema.json`; prose in SKILL.md doesn't redefine it.
- **Assertion-level traceability**: every spec commitment (`behavioral_contract[]`) has exactly one task owner. Coverage is mechanical.
- **Commands are re-verifiable**: work-review spot-checks `state.phases[].artifacts.commands_run` by re-execution. Claims of test passage become evidence.
- **Non-breaking evolution path**: `schema_version` on every artifact; consumers can reject unsupported versions explicitly.

---

## Non-Goals

- Does not add ideation, tracker integration, HITL, validator subagents, persona catalog, or multi-platform tooling.
- Does not change reviewer dispatch (all 6 always fire — predictability preserved).
- Does not introduce conditional reviewer dispatch, confidence-anchor systems, or external service coupling.
- Does not migrate existing plans in-flight — no backward-compat shims. Per project convention, the pipeline changes wholesale.

---

## Open Questions for Review

- **spec.json revision tracking**: when plan-consolidation refines spec.json, should it track `revision_count` or a changelog field? Useful for audit ("what was in the first draft vs after consolidation?") but adds bookkeeping. Or should we write the pre-consolidation spec to a `spec.json.pre-consolidation` sidecar within the session and be done?
- **Research sidecar `context.md`**: keep as-is (sidecar) or absorb into spec.json's `context` field at plan-creation time (and delete the sidecar — one fewer artifact)?
- **State write cadence**: per-task, per-phase, or per-checkpoint? Per-phase is simplest; per-task preserves finer-grained recovery after interrupt; per-checkpoint matches the existing Flywheel convention.
- **Re-execution scope in work-review**: sample N commands (N=3?) or all? All is thorough but expensive if a phase ran many commands; sampling loses some coverage but is bounded.
- **User edits to spec.json between plan-creation and work**: if the user edits the spec.json (e.g., adds a task), does work-implementation just run against the edited version? (Probably yes — that's the whole point of JSON being hand-editable.) Do we need to re-validate the BC coverage check on user-edited spec before work-implementation begins? (Cheap mechanical check, probably worth running as a pre-flight.)
- **Slug collision on same day**: if user invokes `/fly:plan` twice on the same day with the same slug (`add-auth-2026-04-23` already exists), what does plan-creation do? Options: error, append `-2`, overwrite (destroying prior work), or treat as resume. Recommendation: append `-2` with a user-visible notice.
- **Session list/switch/delete commands**: not required for core functionality but natural next additions. Worth including in this plan as a follow-on, or defer?
- **TUI convergence**: should `flywheel/schemas/*.schema.json` eventually be published as a standalone package both tools import, or stay plugin-local and the TUI maintains its own copies? Former costs setup but eliminates drift; latter is simpler short-term.
- **TUI migration timing for separate findings.json**: low priority — the TUI's in-place annotation model works today. Migrate when schema-sharing is the priority or when workflow flexibility (re-consolidation, durable findings archive) becomes painful.
- **Backward scope for existing plans in `docs/plans/`**: no migration path — confirm user comfortable with a clean break. Any existing plans under `docs/plans/` become stale; users either finish them under the old convention or start over under the new session model.
