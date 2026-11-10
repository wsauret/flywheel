## Reviewer Protocol

### Assemble Project Context Paths

There is no discovery phase.

1. Use the project context paths supplied by the dispatching agent or listed in the input plan or design verbatim as `PROJECT_CONTEXT_PATHS`.
2. Only if no paths were supplied: use document paths identified by repository instructions or existing project context. If none are known, run one bounded path-discovery pass for architecture, decision records, and coding guidelines using the repository's layout. No matching documents is valid. Do not read the matches; the content is for reviewers, not for you.

Inline `PROJECT_CONTEXT_PATHS` in every reviewer dispatch under "PROJECT CONTEXT PATHS." If there are no paths, pass `none`. You may search or read further context later when a specific synthesis question requires it, but never as a mandatory pre-dispatch phase.

### Dispatch Reviewers in Parallel, Then Recover Narrowly

Default: dispatch every chosen reviewer in parallel through multiple `subagent` calls in one parent turn. Do not predict that a large spec or diff will stall, and do not split a healthy dispatch in advance. If the runtime continuation says the previous response stalled while composing output, do not rebuild the same large batch. Dispatch one remaining reviewer per parent turn without waiting for running reviewers, then collect results after every reviewer has started.

{{if:type:general}}
**Self-contained prompts only - never `fork: true`.** The dispatch template already carries everything a reviewer needs (the review target inline, the context paths, the constraints). Forking re-sends the entire conversation of the agent to every reviewer for zero information gain; with a full reviewer set that multiplies input cost several times over.
{{else}}
**Self-contained prompts only.** The dispatch template already carries everything a reviewer needs (the review target inline, the context paths, the constraints).
{{end}}

Compose each reviewer prompt from the template of the invoking brief, and paste this block into every one:

```
Before assessing your domain, read the project context paths listed below that bear on this change's files and domain; skip paths with no bearing on it. Mandatory elegance applies to every domain; do not defer structural judgment to another reviewer.

Required output discipline:
1. Reviewers emit prose findings, one block per finding with these parts: Title, Severity, Location, Failure, Fix. Do NOT emit JSON; the synthesizer structures your output. Use structured sections, paths only rather than file contents, and flag an ambiguity as `OPEN QUESTION:`.
2. Locations are always concrete: `path/to/file.ts:42-67`, never "in the auth module."
3. Format each Failure as four slots: `**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.` Principle name = any well-known principle (elegance catalog, SOLID, DRY, language-specific anti-pattern, performance/data-integrity canonical name like "N+1 Query" or "Race Condition"). The synthesizer uses the leading name to route structural failures to redesign vs patch - keep it the first token. Intent = what the code or plan was trying to achieve; Observation = the specific discrepancy from that intent; Reasoning = why the discrepancy matters for users, the system, or design integrity. The paragraph is the only input on the problem for the agent that repairs it, so it must carry the full scope in one read: "Silent Logout. parseDate is supposed to accept the date formats users actually submit. It only handles YYYY-MM-DD and returns null for DD/MM/YYYY; the caller at line 78 treats null as 'expired' and logs the user out. DD/MM/YYYY input becomes a silent logout, a wrong outcome and confusing UX." If you cannot lead with a principle name, the finding is observational only: mark it P3 or suppress it.
4. Each Fix MUST propose the elegant alternative concretely, not just flag the issue. The agent that repairs it treats your Fix as a hypothesis - be specific without over-prescribing.
5. Preserve every runtime-behavior claim the reviewer's method tags `UNVERIFIED`; do not resolve or discard it in wave 1. These route to reviewer-mechanism in wave 2. A claim confirmable by a single direct read is literal state and carries a `file:line` without the tag.
6. The supplied user requirements and Design intent bind you. Where the user chose a tool, library, framework, or approach, do not propose an alternative; propose only where the user was silent. The section labeled `Design intent` is the fixed tier: judge the target against it, classify deviations against it, and never propose an alternative to it. A later instruction from the person replaces the choice that it names; everything outside the fixed intent is implementation design that the implementation may revise. A finding that contradicts a documented rejection must explain why the rejection no longer holds, or it is suppressed. An entry that starts with `Deferred:` records a recommendation that consolidation chose not to integrate: work that traces back to one is principled extension, not an implementation error, so note it once instead of re-flagging the recommendation as new.
7. Hardening findings name their trigger. A finding that proposes defending against a failure mode carries the concrete occurrence that produces it: a design requirement, or a `file:line`/named caller whose normal operation or existing input source actually produces the failure. "This write could be interrupted" or "this input could be hostile" is a physical possibility, not a trigger: state the assumption in one sentence and cap the finding at P3. Severity above P3 for hardening requires the named trigger.
```

#### User constraints

Read the supplied user's words and Design intent literally, not charitably. A finding that proposes an alternative where the user already chose one is a contradiction to tag, never a recommendation to integrate. Later instructions from the person replace the choices that they name. Keep the plan's revisable rationale, rejected alternatives, and deferred recommendations distinct from fixed intent. Item 6 of the dispatch block carries these rules to every reviewer; apply the same reading during synthesis.

### Wave 2: Mechanism Verification

After the wave-1 reviewers return, assemble the **behavioral claims to verify** - the union of: (a) every claim a wave-1 reviewer tagged `UNVERIFIED`; (b) any runtime-behavior claim the input plan or design asserts that a finding depends on; and (c) any **contradiction** between two reviewers, or a reviewer and the target, about runtime behavior - treat the contradiction explicitly as a claim to resolve.

Every claim gets a verdict - `supported` | `partially_supported` | `contradicted` | `unverified` - each with a `file:line` naming the exact evidence checked. Evidence for a weaker predicate does not verify a stronger predicate: a range does not verify an exact pin, presence does not verify behavior, and a fixture does not verify the live path. Who produces the verdicts depends on the size of the docket:

- **Empty docket:** no behavioral claims and none load-bearing in the plan. Skip wave 2 entirely; do not dispatch a subagent to report "nothing to verify."
- **Small docket** (a handful of claims, each traceable with a few targeted reads or searches): verify them yourself, inline, before synthesis. Trace each claim to ground truth in the code - read the actual code path, do not reason from plausibility - and record the same verdict + `file:line` per claim. Prefer the inline path whenever the docket fits in a few minutes of reading (proportionality rule).
- **Large or deep docket** (many claims, or claims requiring multi-file execution traces across subsystems you have not read): dispatch `reviewer-mechanism` ONCE (a single subagent call, not in the wave-1 parallel batch - it consumes what wave 1 produced). Pass it: 1. the plan content inline; 2. the behavioral claims to verify; 3. the PROJECT_CONTEXT_PATHS. It has no severity opinions, only verdicts.

Correctness gates never shrink (proportionality rule): a verdict comes from tracing code, whoever does the tracing, and the docket is never trimmed to fit inline - if honest verification exceeds light exploration, dispatch.

### Synthesize Findings

**Synthesis is internal work.** Extract, dedup, and triage findings in your reasoning. Do NOT print per-reviewer tables, per-reviewer tallies, or the dedup matrix as text output. The only user-facing text from synthesis is the final summary specified by the invoking brief.

Reviewers return natural-language prose; the synthesizer (you) is the single schema enforcer.

#### Extract findings

For each reviewer response:

1. Extract per-finding: Title, Severity, Location, Failure (paragraph), Fix.
2. Validate location format: must match the tier specified by the invoking brief. Wrong-tier locations are a disambiguation failure; construct a synthetic P1.
3. If the reviewer returned "No findings," record zero findings.
4. If a reviewer's output is incomplete, empty, or timed out, construct a synthetic P1 noting the gap AND retain any partial findings. If half or more of the reviewers fail, surface that in the summary but still proceed with whatever did parse.

#### Semantic dedup

Walk the combined findings and group those describing the same issue; reviewers may phrase a shared concern differently. Group by meaning, not by string match.

For each group:
- Take max severity (P1 > P2 > P3) from concrete impact. Corroboration does not promote severity or authority; a P3 that three reviewers flagged is still a P3.
- Merge the Failure evidence into one complete statement of intent, observation, and consequence. Preserve the leading principle name from the four-slot format.
- Separate the claimed constraint from each proposed Fix. A specialist owns evidence in its domain, not the architecture of the remedy; every Fix remains a candidate hypothesis until mechanism verdicts and constraint triage settle the evidence.

**Cross-finding pattern detection:** count findings by leading principle name. If the same name appears in 3+ distinct findings, tag the cluster as a possible structural issue. A cluster is evidence to inspect shared structure, not permission to add an abstraction.

#### Apply the mechanism verdicts

Wave 2 produced a verdict per behavioral claim (yours inline, or reviewer-mechanism's). Apply them before integrating findings - a finding built on a refuted premise must never reach the spec:

- **`contradicted`** - the evidence disproves the claim. Drop or rewrite every wave-1 finding that depended on it. If the input plan or design itself asserted the contradicted claim, emit a P1 finding to correct it.
- **`supported`** - the evidence establishes the claim as stated; cite the verifier's `file:line`. Dependent findings stand on verified ground.
- **`partially_supported`** - the evidence establishes a weaker claim than asserted. Rewrite the claim and every dependent finding to exactly what the evidence supports; the unsupported remainder is `unverified`.
- **`unverified`** - the verifier could not resolve it. Do not integrate a dependent finding as if true. Route the exact claim to synthesis for further repository evidence, focused research or experiments, and mechanism verification. If decisive evidence remains unavailable, preserve the exact gap under the result contract of the invoking brief; this shared protocol does not choose user interaction or terminal routing.

A behavioral premise that no reviewer tagged and the verifier never saw is itself a gap. If synthesis notices a finding resting on an unverified runtime claim, treat it as `unverified`. Severity is never an excuse to skip verification: a P1 built on an untraced behavioral claim is still untraced. Resolve it before handoff when possible; otherwise preserve the exact evidence gap without assigning it to the repair.

#### Tag contradictions with the verbatim prompt

Keep findings that contradict the verbatim user prompt in the list, but tag them:
- Prefix the `title` with `[Contradicts user] `
- Append one sentence to `failure`: `Deferred: contradicts the supplied user requirement or Design intent ('<user words>'); record the pushback, do not auto-integrate.`

Findings that fill in *underspecified* hows, robustness, security, type hints, error handling, pass through untagged.

#### Scale findings to actual size

If reviewers surface an outsized number of findings relative to the review target's size, trim generic critiques, style preferences the schema already permits, and theoretical scaling concerns far below the actual scope.

#### Triage P3 findings

P3 findings are opt-in. Keep one only when concrete evidence shows that it improves correctness or elegance and its proposed remedy survives the same constraint-and-shape arbitration as higher-severity findings. Drop style preferences, hypothetical hardening, theoretical scale concerns, optional robustness, and changes with no behavioral or structural consequence. Reviewer count does not rescue a P3, and a specialist label does not make it actionable. Do NOT ask the user which P3s to keep.

#### Arbitrate remedy shapes after evidence settles

Only after mechanism verdicts, prompt contradictions, actual-size scaling, and P3 triage have settled the surviving constraints, select remedies. Preserve explicit requirements and confirmed correctness, security, data-integrity, performance, and runtime constraints as hard gates. Among remedies that satisfy those gates, elegance governs: choose the simplest feature-complete correction with the fewest new owners, states, layers, abstractions, and failure branches.

Other reviewers identify requirements the solution must meet. They do not decide the solution. Once those requirements are met, choose the most elegant solution, no matter how many reviewers prefer another approach.

Never union reviewer fixes or count reviewer agreement. Three specialists recommending three defensive mechanisms do not outweigh one simpler shape that satisfies all three verified constraints. The elegance reviewer is not one equal vote; its perspective governs structural arbitration, though the synthesizer may choose an even simpler remedy when it preserves every confirmed constraint. If several surviving findings share one root and one coherent correction resolves them more simply than local fixes, select that correction; otherwise keep genuinely independent failures separate.