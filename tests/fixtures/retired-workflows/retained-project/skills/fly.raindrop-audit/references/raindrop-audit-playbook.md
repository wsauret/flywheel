# Raindrop Inspiration Audit Playbook

This playbook turns Raindrop bookmarks into disciplined Flywheel inspiration audits. The goal is not to create work from every interesting source. The goal is to identify sources that materially improve the Flywheel end-user experience, preserve the evidence, and avoid reprocessing the same bookmark.

Depth is mandatory. A shallow skim is worse than no audit because it creates false confidence and noisy plans. If the agent cannot read the source deeply enough to defend a proposal, it must leave the bookmark claimed or remove the claim with a clear "not audited" note; it must not mark the bookmark analyzed.

## Launch from chat

Ask the chat in a source run to run a Raindrop audit. The chat launches the template with the `workflow` tool: `{ kind: "path", path: "src/orchestration/modules/development/raindrop-audit.workflow.yaml" }`. The path is relative to the Flywheel repository root, the working directory of a source run. The launch description names the bookmark if the person named one. The chat must not claim or audit the bookmark itself.

An agent inside the Raindrop audit workflow skips this launch section and follows the audit instructions below.

## Path Root

The working directory in the `<env>` block is the workspace root for every audit artifact, clone, source citation, and handoff path. Write `docs/` and `inspiration/raindrop/` below that directory. Keep document text and handoff values relative to the same workspace. Do not write audit outputs at an enclosing Git repository root.

## Queue State

Use the whole Raindrop account as the external queue. Every bookmark is presumed relevant to Flywheel unless it is already tagged as processed or currently claimed. Tags are the source of truth for processing state, not for initial relevance filtering.

| Tag | Meaning |
|---|---|
| `flywheel-inspiration` | Optional label for manually highlighting an especially promising source. This tag is not required for queue membership. |
| `flywheel-claimed` | An agent is currently auditing this source. The default queue command hides claimed items. |
| `flywheel-source-blocked` | The source could not be read deeply enough with available unauthenticated access. This is not an analyzed outcome. |
| `flywheel-analyzed` | Audit is complete. The source should not be processed again unless the user explicitly removes this tag. |
| `flywheel-noop` | Audit found no significant Flywheel improvement and returned no lane candidate. |
| `flywheel-proposal` | Audit created a new `private/plans/` proposal or materially improved an existing one. |
| `flywheel-banked` | Audit wrote no plan and returned at least one definition-lane candidate. |

Commands:

```bash
bin/flywheel dev raindrop queue --format markdown
bin/flywheel dev raindrop claim <bookmark-id>
bin/flywheel dev raindrop mark-blocked <bookmark-id>
bin/flywheel dev raindrop mark-analyzed <bookmark-id> --outcome noop
bin/flywheel dev raindrop mark-analyzed <bookmark-id> --outcome proposal
bin/flywheel dev raindrop mark-analyzed <bookmark-id> --outcome banked
bin/flywheel dev raindrop remove-tag <bookmark-id> flywheel-claimed
```

The queue markdown output prefixes each line with the bookmark id; use it directly for claim and mark commands. Do not rerun the queue with another format to find ids. The markdown output also includes each bookmark's note, so a separate get is only needed when you want the full record.

If an agent claims a bookmark and cannot finish, it must either remove `flywheel-claimed` or explain why the claim remains.

The queue command means "all bookmarks that are not `flywheel-analyzed`, not `flywheel-claimed`, and not `flywheel-source-blocked`." Use `--tag <tag>` only when the user explicitly asks to process a tagged subset. If the default queue is empty, there is no unread work; do not fall back to recent bookmarks. `flywheel-source-blocked` is a source-access state, not an audit decision; remove it only when the user provides a new access path or explicitly asks to retry blocked sources.

**Fresh-audit reset:** If a bookmark re-enters the queue because its processed or blocked tags were removed, treat it as a new audit. Prior research artifacts, prior audit decisions, prior matrices, prior exclusions, and prior source-coverage claims have no evidentiary weight and must not be read or used to narrow the audit. Fetch or clone the source again, inventory it again, compare it with current Flywheel behavior, and write a new dated research artifact. Existing plans remain relevant only as current ownership surfaces, not as evidence that the prior audit was correct.

## Bookmark Note

The Raindrop `note` field is an additional user prompt attached to that one bookmark. Read it before starting the audit:

```bash
bin/flywheel dev raindrop get <bookmark-id>
```

The note says what the source is for. It can redirect the purpose and the deliverable of the audit, not only the priorities inside it. A note that says "use this to audit our codebase for generic names" means the article is a lens for inspecting Flywheel, not a candidate design proposal.

The note selects the audit mode:

| Mode | When | Question the audit answers |
|---|---|---|
| Default | The note is empty, or only adds emphasis inside the normal source-versus-Flywheel comparison. | Does this source contain a concrete idea that would materially improve Flywheel's end-user experience? |
| Directed | The note names a different purpose, deliverable, or question. | The question the note asks, in the note's own terms. |

Directed mode changes the question and the artifact structure. It never relaxes evidence discipline:

- The source coverage gate applies in full. A narrower deliverable is not a license to skim the source.
- Every claim about Flywheel still needs file-line citations.
- The Flywheel decision matrix is required in default mode. In directed mode, replace it with the structure that answers the note's question and say in the artifact why the matrix does not apply.
- Outcomes are unchanged: the note's question is routed like any other finding, so a directed audit still ends `noop`, `proposal`, or `banked`.

Record the note verbatim in the research artifact and state how it shaped the audit. If the note is ambiguous enough that two different audits would both satisfy it, message your parent with `message_session` and wait for its reply before spending the audit budget.

## Audit Contract

Unless the bookmark note directs otherwise, every audit answers one question:

> Does this source contain a concrete idea that would materially improve Flywheel's end-user experience?

For jobs that appear to overlap with Flywheel, the question is stricter: not whether Flywheel has similarly named primitives, and not merely whether the same job is wired up, but whether the source handles that job in an appreciably better way than Flywheel does today.

That question can only be answered after four gates are complete:

1. **Source coverage gate:** Inventory the source and read every relevant artifact fully. For articles, this means the full article plus linked sections that carry the argument. For GitHub repos, this means every file that defines the bookmarked system's user-facing model, commands, prompts/specs, runtime behavior, persistence, evaluation, UI, or install/use path. Exclude only obviously irrelevant files such as binary assets, licenses, funding metadata, generated lockfiles, vendored dependencies, and `.git/` internals; list those exclusions explicitly.
2. **Flywheel surface-map gate:** Map the source's mechanisms to the applicable Flywheel surfaces before judging value: ADRs, workflow YAML, briefs, handoff schemas, validators, queue/session/runtime code, TUI surfaces, the improvement lane, the managed skill library, private/plans, and AGENTS.md. Read the Flywheel files needed to verify each surface.
3. **Capability decomposition gate:** Never dismiss a source mechanism at category level. "They have planning, Flywheel has planning" is invalid. Break each mechanism into the jobs it performs, then compare those jobs separately. For planning-like systems, this means at minimum: user-intent capture, requirements shape, acceptance criteria, codebase grounding, design alternatives, review/approval, task decomposition, dependency modeling, verification mapping, traceability, and post-run learning. For review-like systems, split reviewer selection, evidence required, rubric shape, consolidation, action routing, and proof surface. For runtime/tool systems, split command surface, tool schema, permissions, persistence, cancellation, recovery, inspection, and user feedback.
4. **Better-not-different gate:** For each decomposed candidate idea, decide whether it is materially better than Flywheel's current behavior, merely different, already equivalent, or actively worse. A plan is allowed only for "materially better" ideas, and the audit must state why the current Flywheel surface is insufficient. **A primitive existing is not the capability existing.** Before judging a row `equivalent`, trace the actual wiring at file-line, that is, what triggers it, the control flow, and where it terminates, and confirm the source's specific job is performed today. When the same job is performed in both systems, compare the exact execution mechanics: trigger, authority boundary, data model, user-visible feedback, inspection surface, failure handling, retry or recovery path, and termination condition. If the source performs the same job in an appreciably better way, the row is `better` even when Flywheel already has a working analogue. A similarly-named primitive that is wired for a different job (different trigger, re-runs a different unit, terminates on a different condition) is also a `better` gap, not `equivalent`. When that is the case, the proposal must frame the net-new wiring or better execution pattern as the substance and the existing primitive only as a discipline or building block to reuse, never as evidence the capability is already present.

5. **Parity-proof gate:** Treat current ADRs as records of adopted architecture, AGENTS.md rules as repository constraints, research as evidence, and open `private/plans/` proposals as intended direction. If a forward-looking ADR is encountered, migrate its useful material into the owning plan and delete it; do not use it as implementation authority or proof of current capability. None of these documents alone proves current product behavior. Before judging a row `equivalent`, `already owned`, or `different but not better`, write a parity proof in the matrix:
   - **Trigger:** what user action, workflow event, hook, tool call, runtime condition, or debug command starts the behavior in both systems.
   - **Control flow:** the concrete files/functions that carry the behavior to completion in Flywheel.
   - **State model:** the durable data written/read, including whether it is source, fact, projection, cache, or sidecar.
   - **Inspection surface:** how a user or debug command can see that the behavior happened and why.
   - **Feedback/recovery:** how the user or agent corrects, retries, supersedes, rejects, or audits the result.
   - **Termination:** where the behavior stops and what observable output or state change proves it completed.

   A missing capability is a candidate gap, not automatic evidence that the source is `better`. Its absence does not by itself make the source `better`. Judge it `better` only when the source evidence demonstrates material benefit for Flywheel under the current implemented architecture and approved outcomes. An absent capability that is unjustified, nonbeneficial, or undesirable can support a non-`better` judgment and a `noop` outcome. An existing plan that would eventually fill a materially better gap changes the proposal target, not the row judgment: update the plan when the source materially sharpens it; create a new plan when no plan owns the implementation gap.

6. **No-op adversary gate:** Before deciding `noop`, run a final adversarial pass over the completed matrix:
   - List every source behavior that would make a Flywheel user say "we do not have that today."
   - For each behavior, cite the exact Flywheel production path that already delivers it, or assess whether the absent behavior has demonstrated material benefit. Change the row to `better` only when that benefit is established.
   - Check that the no-op conclusion does not rely primarily on words like "doctrine", "planned", "should", "could", "ADR", "proposal", "direction", or "already-owned."
   - Preserve the full parity proof before claiming `equivalent`. If any row is materially `better`, the outcome cannot be `noop`: route the row under Better-Row Routing.

The Flywheel decision matrix is a pre-decision working artifact, not a summary table written after the conclusion. Build it before routing any row, and let the routes and the outcome follow from the rows. Any proposed design doc, enhancement to an existing plan, or lane candidate must trace to one or more matrix rows whose judgment is `better`; if a proposed change cannot be derived from a `better` row, do not produce it. In directed mode the replacement structure carries this same burden: it is built before the decision, and every routed row must trace to the evidence in it.

Material means one of these:

- A user-visible workflow, TUI, feedback, inspectability, reliability, or operating-model improvement.
- A simplification that would make Flywheel easier to trust, resume, debug, or steer.
- A source-backed design that sharpens an existing Flywheel direction enough to change implementation choices.

Before proposing a change, compare the source against existing Flywheel compounding lanes, current architecture, and plans. In particular, check whether the idea is already covered by the managed skill library, workflow definitions, handoff schemas, validators, rubrics, AGENTS.md, a current-state ADR, or an existing `private/plans/` proposal. Forward-looking work belongs in plans, never in a retained ADR. A proposal must name the gap it fills rather than restating an existing lane. If an existing plan already owns the target surface, improving that plan is preferred over creating a duplicate proposal; record the updated plan path in the research artifact's `proposal_path`.

Do not create a plan for:

- Generic inspiration with no clear Flywheel consequence.
- Implementation details that are merely different, not better.
- Ideas that improve internal aesthetics without changing user experience, inspectability, reliability, or agent effectiveness.
- Features that conflict with current implemented architecture unless the plan explicitly identifies the architectural migration and the resulting ADR update required after implementation.

## Better-Row Routing

Every matrix row judged `better` is routed to exactly one owner. Size and ownership decide the route, never enthusiasm:

| Route | When | Artifact |
|---|---|---|
| New plan | No existing plan owns the target surface, and the change needs a design: several surfaces, a migration, or a sequence of steps. | `private/plans/{slug}.md` (bare topic slug, no date prefix; the `Date:` header carries the date) |
| Existing plan | A plan already owns the target surface and the source sharpens, extends, constrains, or reorders it. | That plan, updated |
| Definition lane | The change is a bounded edit to one definition Flywheel already owns: a brief, workflow template, handoff schema, review rubric, validator, test, project instruction, or ADR. | A `definition_proposals` candidate in the handoff |
| Research note | The row is durable knowledge that is not a change to a Flywheel definition. | A section of the research artifact; the learning review owns durable capture from sessions |

Choose the smallest route that owns the change. A bounded definition edit never becomes a plan, and a plan never carries a change one definition edit would deliver. A row routed to a lane is still a `better` row, so an audit with no plan and one lane candidate is a complete, non-empty audit.

## What the Audit Writes

The audit writes the research artifact under `docs/research/` and, for a proposal outcome, a new or updated plan under `private/plans/`. When it creates a new plan, it must also add that plan to the plan index, `README.md` in `private/plans/`, in the correct section, and create the index when it does not exist with its canonical status and a one-line scope summary. An update to an existing plan must not add a duplicate roster entry. Lane candidates are returned, never written. The deterministic consumer vets each candidate after the audit finishes and writes the `private/improvements/` document itself, so the audit must not create or edit one, and it must never edit the definition a definition-lane candidate is about.

## Outcomes

| Outcome | When | Terminal tags |
|---|---|---|
| `proposal` | The audit created or updated a `private/plans/` document. | `flywheel-analyzed` + `flywheel-proposal` |
| `banked` | The audit wrote no plan and returned at least one lane candidate. | `flywheel-analyzed` + `flywheel-banked` |
| `noop` | The audit wrote no plan and returned no lane candidate. | `flywheel-analyzed` + `flywheel-noop` |

The outcome follows from the routed rows; it is never chosen directly. Both `noop` and `banked` are successful outcomes.

In the Raindrop audit workflow the audit never tags the bookmark. The handoff carries the routed lane candidates, and the deterministic consumer records the lanes, appends the completion fact, and applies the terminal tags only after that fact is durable. A failed Raindrop call leaves the recorded audit intact and is retried on the next pass. Apply the tags by hand with `mark-analyzed` only for an audit run outside the workflow.

## X Source Access

Use this for `x.com` and `twitter.com` bookmarks, or for article sources where the only visible source is an X post or thread. Flywheel does not assume an X API token is available. Do not ask the user for one unless they offer it; use unauthenticated resolution first.

Canonical retrieval command: for every article-like bookmark, including `x.com`, `twitter.com`, and X Articles, first run `bin/flywheel dev fetch-article <bookmark-url> -o <scratch-path>.md`. The helper owns X resolution and fallback behavior. Do not call oEmbed or FxTwitter manually unless the helper fails or its output is insufficient for the source coverage gate. When manual fallback is necessary, use oEmbed first and FxTwitter second.

If `bin/flywheel dev fetch-article` fails or returns insufficient content, resolve X sources manually in this order:

1. **Official oEmbed:** Fetch the public post through `https://publish.x.com/oembed?url=<encoded-url>&omit_script=1`. If it returns the post text and the X post only introduces a linked article, GitHub repository, paper, or product page, treat the linked target as the source under audit and record the X post as provenance.
2. **FxTwitter JSON:** If oEmbed is missing, truncated, or insufficient for the audit, fetch the post through `https://api.fxtwitter.com/2/status/<post-id>`. For threads, use `https://api.fxtwitter.com/2/thread/<post-id>`. For profile article lists, use `https://api.fxtwitter.com/2/profile/<handle>/articles?count=20`. Record that this is an unofficial unauthenticated resolver and preserve the original X URL in the research artifact.
3. **Linked source:** If either resolver exposes an outbound article, GitHub repository, documentation page, paper, or project website, read that target directly and audit it under the normal article or repository flow. Do not spend the audit budget reconstructing X replies when the durable source is elsewhere.
4. **Blocked:** If the bookmark is X-only and neither oEmbed nor FxTwitter gives enough content to satisfy the source coverage gate, stop. Do not use login-gated browser sessions, paid scraper vendors, or rotating public mirrors unless the user explicitly approves that source-access method for the run. Mark the bookmark blocked:

```bash
bin/flywheel dev raindrop mark-blocked <bookmark-id>
```

A blocked X source is not a no-op and must not be marked `flywheel-analyzed`. In the user-facing note, say which resolvers were attempted and why the source coverage gate could not be satisfied.

Do not treat FxTwitter or Nitter-style mirrors as authoritative. They are best-effort access helpers for public content. Any proposal still needs durable evidence from the actual article, repository, documentation, or quoted X content that the resolver returned.

## Article Flow

Use this for essays, blog posts, papers, documentation pages, and non-repository sources.

1. Claim the bookmark and read its note:

```bash
bin/flywheel dev raindrop claim <bookmark-id>
bin/flywheel dev raindrop get <bookmark-id>
```

2. Read the source in full. Fetch it with the article fetch helper, which returns readable markdown through the r.jina.ai readability proxy and falls back to raw HTML from a direct fetch when the proxy fails; many help centers and docs sites 403 plain curl but pass through the proxy:

```bash
bin/flywheel dev fetch-article <url> -o <scratch-path>.md
```

If the page has linked sections that are part of the article's argument, fetch and read those too. Do not skim only the introduction or conclusion. If every fetch strategy fails and no alternate access path exists, treat the source as blocked, not as thinly audited.

3. Write a research artifact under `docs/research/{date}-{slug}.md` with:

- Bookmark id, title, URL, Raindrop tags, verbatim note, audit mode, and retrieval date.
- Source thesis in the source's own terms.
- Claims relevant to agentic coding, workflow design, evaluation, context, persistence, review, UX, or operator control.
- Flywheel decision matrix written before the decision, with each candidate capability judged as better, equivalent, different-but-not-better, worse, or not applicable. For overlapping jobs, include the exact execution comparison that justifies the judgment. In directed mode, the structure the note calls for replaces the matrix.
- Comparison against Flywheel's current ADRs and implementation.
- Decision: every row judged `better` with the route chosen for it, and the outcome those routes produce: `noop`, `proposal`, or `banked`.

4. Route every `better` row under Better-Row Routing. Create a new `private/plans/{slug}.md` only for a row routed to a new plan, and only when the improvement traces to that row. When you create a plan, add its one-line roster entry to the correct section of the plan index in the same change. Update the owning plan for a row routed to an existing plan, without adding a second roster entry. Return a definition-lane row as a handoff candidate and write no document for it. The new or updated plan must include:

- The user-facing problem or opportunity.
- The source-backed insight.
- The matrix row or rows that justify the proposal.
- The proposed Flywheel change.
- The affected Flywheel surfaces.
- Validation strategy.
- Risks and rejected alternatives.

5. Mark the bookmark with the outcome the routed rows produced. In the Raindrop audit workflow the consumer does this from the handoff; run the command by hand only for a manual audit:

```bash
bin/flywheel dev raindrop mark-analyzed <bookmark-id> --outcome noop
bin/flywheel dev raindrop mark-analyzed <bookmark-id> --outcome proposal
bin/flywheel dev raindrop mark-analyzed <bookmark-id> --outcome banked
```

## GitHub Repository Flow

Use this for GitHub repositories, source archives, and implementation-heavy examples.

1. Claim the bookmark and read its note with `bin/flywheel dev raindrop get <bookmark-id>`.

2. Clone the repository locally before judging it. Use a stable path under `inspiration/raindrop/`:

```bash
mkdir -p inspiration/raindrop
git clone <repo-url> inspiration/raindrop/<bookmark-id>-<owner>-<repo>
git -C inspiration/raindrop/<bookmark-id>-<owner>-<repo> rev-parse HEAD
```

Record the exact commit hash in the research artifact. If the source is large, clone normally first; use sparse checkout only after identifying the relevant areas.

3. Build a source inventory before analysis:

```bash
git -C inspiration/raindrop/<bookmark-id>-<owner>-<repo> ls-files | sort
find inspiration/raindrop/<bookmark-id>-<owner>-<repo> -path '*/.git/*' -prune -o -type f -print0 | xargs -0 wc -l | sort -n
```

Record the inventory summary in the research artifact: file counts by directory, total relevant lines, excluded files, and why each excluded category is irrelevant.

4. Inspect the source before comparing it to Flywheel. Start from README, package/config files, command surfaces, workflow definitions, agent prompts, persistence/runtime layers, and user-facing UI code. Then follow references into the implementation. Read relevant files fully; do not rely on partial snippets except for files already established as irrelevant.

If the repository is mostly prompts, specs, workflows, or documentation rather than executable code, treat those files as the implementation surface. They still require exact file-line citations. Do not dismiss the repository for lacking TypeScript/Python/Rust application code if the bookmarked artifact is itself a workflow, prompt pack, or design system.

5. Write a Flywheel decision matrix before deciding. This matrix is the load-bearing comparison artifact, not a decorative recap. Fill it while comparing source capabilities to Flywheel surfaces, then make the `noop` or `proposal` decision from the completed rows. In directed mode, build the structure the note calls for instead and record why the matrix does not apply:

- Source capability.
- Failure prevented.
- Flywheel analogue.
- Implementation evidence.
- Execution comparison.
- Consequence for the end user.
- Judgment: better, equivalent, different-but-not-better, worse, or not applicable.

6. Write a research artifact under `docs/research/{date}-{slug}.md` with:

- Bookmark id, title, URL, verbatim note, audit mode, local clone path, and commit hash.
- Repository purpose and user-facing model.
- Source coverage summary and exclusions.
- The exact files and line numbers that support every borrowed idea.
- Flywheel decision matrix with file-line citations for current behavior.
- What Flywheel already does similarly.
- What Flywheel should reject.
- Decision: the route chosen for every `better` row, and the outcome those routes produce: `noop`, `proposal`, or `banked`.

7. Route every `better` row under Better-Row Routing. Create a new `private/plans/{slug}.md` only for a row routed to a new plan, and add its one-line index entry to the correct section of the plan index in the same change. Update the owning plan for a row routed to an existing plan, without adding a second roster entry. Return a definition-lane row as a handoff candidate and write no document for it. The new or updated plan must include source evidence as file-line citations from the local clone, Flywheel evidence as file-line citations from this repo, and the matrix row or rows that justify the proposal:

```markdown
Source evidence:
- `inspiration/raindrop/<bookmark-id>-<owner>-<repo>/path/to/file.ts:42` - [what this proves]
- `inspiration/raindrop/<bookmark-id>-<owner>-<repo>/path/to/other.ts:118` - [what this proves]

Flywheel evidence:
- `src/agent-skills/workflow-authoring/SKILL.md:42` - [current behavior]
- `docs/architecture-intent/agency.md:5` - [relevant design constraint]
```

Do not cite only README claims when implementation evidence exists. A follow-up implementation agent must be able to reopen the cloned source and find the exact inspiration material.

8. Record the outcome the routed rows produced, and only after the research artifact passes the source coverage gate, Flywheel surface-map gate, and better-not-different gate. If any gate is incomplete, the bookmark is not analyzed: in the workflow, do not emit a completed audit; by hand, do not run `mark-analyzed`.

## Research Artifact Template

```markdown
---
date: 2026-06-20
topic: "Raindrop inspiration audit: <source title>"
status: complete
tags: [research, raindrop, inspiration]
bookmark_id: <id>
source_url: "<url>"
decision: noop | proposal | banked
audit_mode: default | directed
proposal_path: private/plans/<slug>.md | null
lane_candidates: <number of definition-lane candidates returned>
coverage: complete | incomplete
---

# Raindrop Inspiration Audit: <Source Title>

## Source

- Bookmark: `<id>`
- URL: <url>
- Type: article | github
- Local clone: `inspiration/raindrop/<id>-<owner>-<repo>` (GitHub only)
- Commit: `<hash>` (GitHub only)

## Audit Directive

- Bookmark note: "<verbatim note, or none>"
- Mode: default | directed
- How the note shaped this audit: <the question answered, the deliverable chosen, and in directed mode why the decision matrix does not apply>

## Source Thesis

...

## Source Coverage

- Files inventoried: ...
- Files read fully: ...
- Files excluded: ...
- Coverage limitations: ...

## Relevant Evidence

...

## Flywheel Decision Matrix

| Source capability | Failure prevented | Flywheel analogue | Implementation evidence | Execution comparison | User consequence | Judgment |
|---|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... | better/equivalent/different-but-not-better/worse/not applicable |

## Flywheel Comparison

...

## Decision

- Rows judged `better`, one line each: `<row> -> new plan | existing plan | definition lane | research note`.
- Rows judged otherwise, one line each: `<row> -> equivalent | different-but-not-better | worse | not applicable`, with the parity proof that settles it.
- Outcome: noop | proposal | banked.
- Why that outcome follows from the routed rows: ...

## Follow-Up

- Definition-lane candidates returned: `<definition the candidate is about> -> <finding>`.
- Memory-lane candidates returned: `<title> -> <knowledge banked>`.
- Open questions for the user: ...
- Deliberately not pursued: `<row> -> <why>`.
```

## Design Bar

A proposal is warranted only when the source changes what Flywheel should build, remove, or expose to the user. The strongest proposals usually affect one of these surfaces:

- Queue or workflow behavior that users can understand and steer.
- TUI status, history, session, or inspection views.
- Agent context, handoff, review, or evidence quality.
- Recovery, replay, durability, or trust boundaries.
- A simpler operating model for the same user outcome.

If the source only confirms what Flywheel already plans to do, write that in the research artifact and mark no-op. If it exposes a better ordering, sharper constraint, stronger evidence, or missing sub-capability for existing work, update the existing plan and mark the bookmark as `proposal`. Do not create a duplicate plan just to satisfy the proposal outcome, and do not inflate a bounded definition finding into a plan: route it to its lane and mark the bookmark as `banked`.

## Invalid Audit Conditions

An audit is invalid and must not mark the bookmark analyzed when any of these are true:

- The agent read only README or selected snippets from a GitHub source.
- The research artifact has no source inventory.
- The bookmark note is not recorded verbatim in the research artifact, or a directed note was silently audited as a default audit.
- The audit is in default mode and the research artifact has no Flywheel decision matrix.
- The audit is in directed mode and the research artifact does not answer the note's question, or replaces the matrix without saying why it does not apply.
- Any row in the decision matrix lacks source capability, failure prevented, Flywheel analogue, implementation evidence, execution comparison, user consequence, or judgment.
- The matrix is presented only as an after-the-fact summary instead of the basis for the decision.
- A proposal or existing-plan enhancement cannot be traced to one or more matrix rows judged `better`, or in directed mode to the recorded evidence that answers the note.
- The audit dismisses a broad category such as planning, review, memory, runtime, tools, or UI as "already covered" without decomposing the source's sub-capabilities and judging each one.
- The proposal does not cite current Flywheel behavior.
- The decision does not explicitly separate "better" from "different" or "already equivalent".
- A row is judged `equivalent` on the strength of a Flywheel primitive existing, without tracing at file-line that the primitive is actually wired to perform the source's job (same trigger, same unit acted on, same termination condition).
- A row with an overlapping Flywheel job skips the execution comparison, or treats "Flywheel already performs this job" as enough without asking whether the source performs it appreciably better.
- The agent cannot explain which relevant files were excluded and why.
- A row judged `better` is not routed to a new plan, the owning plan, the definition lane, or a research note.
- The audit wrote a `private/improvements/` file, or edited a definition one of its candidates is about.
- A new or updated plan has no index entry in the plan index, or has more than one index entry.
- The audit reports `noop` while returning a lane candidate; that audit is `banked`.
- The audit uses a prior audit artifact, matrix, exclusion, coverage claim, or conclusion as evidence, or scopes the new source pass as a delta review, after the bookmark has re-entered the queue through tag removal.
