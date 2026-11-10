# Agency Architecture Intent

This file states how agents, evidence, and deterministic code divide authority over intent, work, and completion.

## ARCH-AGENCY-001: Agent output is evidence, deterministic owners are authority

Every form of agent work, including chat, exploration, subagents, workflow agents, hook checks, and self-review, produces evidence and never directly changes durable Flywheel state. Agents and external systems produce nondeterministic observations and effects. Only a named deterministic owner, such as a validator, a projection, the session manager, a tool contract, or workflow control, decides whether recorded evidence changes owned state. That owner appends or derives the resulting fact, projection, or transition. A completion claim rests on recorded observation that lands as durable facts or inspectable artifacts, never on unrecorded agent assertion.
Because: An agent that both produces work and commits its consequences approves its own output and becomes an unauditable authority.
Not: Letting an agent declaration, such as a handoff that says work is done, set durable state directly.

## ARCH-AGENCY-002: Recording makes judgment accountable, not correct

The deterministic spine guarantees accountability, causality, and one source of truth, not correct semantic judgment. Model judgment is evidence and never becomes durable truth because it is fluent, structured, or faithfully recorded. A model verdict becomes trustworthy only through explicit intent, real feedback, adversarial evaluation, rubrics, tests, and proof surfaces.
Not: Treating an accepted, faithfully recorded model review as proof that the reviewed work is correct.

## ARCH-AGENCY-003: Every capability names both sides of its boundary

A complete capability design names where nondeterminism enters and what records the evidence crossing that boundary. It names the deterministic owner consuming the evidence and the fact, projection, recorded external transition, or rebuildable cache that follows. It names the versioned definition that controls behavior and how success is evaluated. A design that cannot name both the nondeterministic input and its deterministic authority has unbounded nondeterminism, unrecorded evidence, or an unowned durable value.

## ARCH-AGENCY-004: Autonomy scales with recording and structure

More concurrency, longer unattended execution, higher cost, and fewer human checkpoints each require proportionally stronger attribution, evidence, claim mapping, intent versioning, and evaluation independence; greater autonomy never relies on greater ambiguity. A capability does not add autonomy beyond what its recording lets a person inspect and evaluate. Small supervised work may rest on the request, explicit success criteria, validation commands, and a reviewed handoff, while large or long-running work needs versioned intent, traceable decomposition, checkpoint evaluation, and attributable re-specification. Exploratory work may start from a weak target, but a completion claim requires a current inspectable target and evidence against it.
Not: Exhaustive upfront specification before exploration may start.

## ARCH-AGENCY-005: Deterministic ownership is permanent, scaffolding is provisional

Recorded, attributable nondeterministic boundaries and deterministic authority over durable state are permanent. Queue shape, planner and evaluator roles, subagents, handoffs, forks, compaction, memory retrieval, hooks, automatic QA loops, and definition mechanics are hypotheses about what the current model and runtime cannot do alone. Each is added only for an observed failure or a concrete capability it names, and is simplified or removed when it no longer improves correctness, quality, inspectability, context control, or user leverage.
Because: Scaffolding that helped one model generation becomes cargo cult when nobody revalidates it.
Not: Treating orchestration scaffolding such as subagents or handoffs as a permanent requirement that outlives the property it protects.

## ARCH-AGENCY-006: Agent-facing features use existing observable primitives

A new agent-facing feature is first expressed as a typed event, an attempt row, a handoff, a file artifact, a documented command-line tool, or a projection over existing state. A capability that no existing primitive can express adds a typed event, projection, or workflow phase before any bespoke subsystem. No feature hides work, injects context invisibly, or keeps private state outside the durable substrate. A child run's parent-visible result is folded into the parent's completion notification and recorded as facts, with no side file or second hidden history.
Because: Fewer built-ins mean less hidden prompt surface, fewer state machines, cleaner replay, and visible lineage.
Not: A subagent handoff file or a separate result store beside the event history.

## ARCH-AGENCY-007: Feedback surfaces are real

Agents observe real environment outputs: test and lint results, handoffs and session artifacts, prompt snapshots and transcripts, logs and telemetry, process output, and UI state. When a task lacks a feedback surface it needs, the harness adds one as a tool, projection, or inspection surface rather than asking the agent to imagine the result.

## ARCH-AGENCY-008: Repeated failures become durable structure

Durable structure that makes the missing capability or invariant visible remedies repeated agent failure at one task. This may be a test, a validator, a workflow phase, a tool or script, a context selection rule, a typed fact or projection, or an inspection surface. Prompt lengthening and blind retry are not remedies.
Not: Adding more instructions to a prompt each time an agent repeats a failure.

## ARCH-AGENCY-012: Intent, claims, evidence, evaluation, and proof are distinct roles

Every unit of autonomous work keeps five distinct roles. The intent contract states the current target. The claim mapping assigns contract items to responsible work or evaluators. Evidence supports or contradicts a claim. The evaluation record judges evidence against a contract item. The proof explains the resulting state. The owning product or workflow chooses the representation of each role, which may be lightweight at small grain, but the roles never merge at any grain.
Because: Different grains need different structures, while the roles and their invariants are shared.
Not: One universal contract schema or one universal handoff schema that every brief must fill.

## ARCH-AGENCY-013: The target of autonomous work is inspectable

The current target of autonomous work is reconstructible from durable Flywheel history, a versioned artifact, or an explicitly identified external source of record. A target that exists only in hidden prompt text, unrecorded chat memory, or one process's memory cannot authorize autonomous work.

## ARCH-AGENCY-014: External sources of record keep their ownership

When an external tracker or document is the authority for intent, Flywheel preserves its wording and authority, records the version it consumed, and returns its claims and proof without forking ownership of the source value.
Not: A Flywheel-owned requirements system that copies and then owns external requirements.

## ARCH-AGENCY-015: Design intent and implementation design are two tiers of authority

The approved design is design intent: purpose, feature set, dated user decisions, non-goals, constraints with rejected alternatives, verification expectations, and recorded product intent. The user's approval fixes it, and nobody inside an implementation route changes it. Everything beneath it, such as milestones and their order, file lists, decomposition, contract directives, local shapes, and the planned approach, is implementation design, which the implementer owns and corrects against repository reality.
Because: A specification written before the code is touched never survives contact with the code, and an implementer free to redefine the goal reports completion against a target the user never approved.
Not: Literal obedience to an upfront specification treated as complete, or implementer autonomy that extends to requested behavior, prohibitions, or required checks.

## ARCH-AGENCY-016: The tier is a literal label, never inferred

Illustration, such as a candidate file or an example shape, stays outside the Design intent label. Agents read the label and never infer a tier from the wording of a sentence. Text without the label is direction, which never overrides design intent; within one tier, later text applies where it conflicts with earlier text. Every instruction to an implementer states which tier it addresses.

## ARCH-AGENCY-017: Briefs refer to approved intent and never copy it

Briefs, launch descriptions, and specifications refer to the approved design intent that the runtime carries to each child and never copy it into a second authority.
Because: Copied intent becomes a second source of truth that drifts from the user's approval, and a fork's copied history can omit the latest checkpoint.
Not: The dispatching chat pasting design intent into each brief or launch description.

## ARCH-AGENCY-018: Criteria changes are attributed and versioned

The target of work can change, but every material change is attributed and versioned or superseded so that earlier evaluations stay interpretable against the target they judged. A worker never makes success easier after it sees its result and then approves itself against the rewritten target. Only a change to the approved design intent is a criteria change; an implementer revises implementation design and records the deviation in its result.
Because: Without the line, either every implementation adjustment needs approval or goalposts move silently after implementation.

## ARCH-AGENCY-019: Autonomous designs name their intent and proof chain

A design adding autonomous work or a new completion claim names its source of intent, how it reconstructs the current target, and which work claims which part. It names what evidence can satisfy or contradict each material claim and who evaluates judgment-heavy evidence. It names the deterministic owner that consumes the evaluation and the proof the user sees. A design that leaves this to model context is not ready.

## ARCH-AGENCY-020: Every route returns a first draft, and a handoff is evidence

Every implementation route, whether inline work, a subagent, or a workflow, returns a first draft. A returned draft, handoff, generated specification, or verification claim is evidence: a handoff that the runtime accepts proves only that a worker returned a valid payload. Only the intent holder claims completion of a change, after it revises the draft and the review that the change's size requires runs.
Because: Activity is not proof, and only the agent that holds the intent can judge whether a payload realizes it.

## ARCH-AGENCY-021: Deviations travel in the owning result contract

Every material deviation from implementation design travels with the draft in its typed result: what the plan said, what was done instead, why, and the evidence. Each material choice that the design and the brief left open travels the same way, with the option taken and why. Each route carries them in its own existing result contract. A recorded deviation is expected drift; a hidden one is goalpost drift.
Not: A parallel drift record or one universal deviation schema beside the existing result contracts.

## ARCH-AGENCY-022: Judgment-heavy completion has a separate evaluator

When completion depends on judgment, such as review, QA, product completeness, or design quality, the generator may self-review and produce evidence but is never the sole authority that approves the claim. A deterministic validator, an independent reviewer or workflow phase, a person, an external system, or a rubric-backed tool evaluates it, and the required independence scales with risk and reversibility. Criteria, prompts, rubrics, findings, and failure history stay explicit, attributed, and inspectable, and approval attaches evidence against the current target rather than criteria retrofitted after the result.
Because: Self-approval and evaluators tuned to agree turn evaluation into an undetectable rubber stamp.

## ARCH-AGENCY-023: Reviewers classify drift and the intent holder decides

Review runs on the first draft with the design, its constraints, and the recorded deviations. It reports each deviation and discrepancy as consistent with the design or as drift, with evidence, beside defects, and never decides acceptance. The intent holder disposes of every finding against the design and the original request, keeps what serves the intent, realigns what misses it, and fixes defects alongside.
Because: Only the intent holder can judge whether a deviation serves the intent better than the plan did.
Not: Reviewers that accept or reject deviations on their own authority.

## ARCH-AGENCY-024: The agent that holds the intent revises the draft

Revision belongs to the agent whose context carries the approved design: the same agent for inline work, and the dispatching chat for a subagent or a workflow. A fresh agent given only the draft cannot revise it against intent it never saw; a fork that copies the holder's context can. Phases inside a workflow can repair findings and verify their integrated draft, but they address implementation design only, and the chat's revision addresses fidelity to intent.
Because: Fidelity to intent can be judged only where the intent lives.
Not: A rework phase inside the workflow that replaces the launching chat's revision.

## ARCH-AGENCY-025: Revision realigns structure first and is not bounded by a pass count

Drift is the ordinary input to revision, not a defect report or a reason to restart. When the deviations show that a draft is structurally off the design, the intent holder realigns the structure first and reviews the realigned draft, and it never leaves a draft half-realigned because a pass ended.
Because: Reviewing code that is about to be removed is waste, and editing a concrete draft with review evidence is cheaper and more accurate than rewriting from a specification.

## ARCH-AGENCY-026: Route definitions answer the tier design test

Every definition of an implementation route, a brief, a persona, a dispatch prompt, or a result contract states the tier that each instruction addresses. It also states where the implementer records a deviation and whether the draft's receiver holds the intent. An instruction violates this rule when it tells an implementer to stop for a wrong file list or ask the user directly, or tells a receiver to trust a handoff as completion.

## ARCH-AGENCY-030: Passing checks are quiet, failing checks are concise

Passing checks record durable evidence without adding verbose output to model context. Failing checks surface the smallest actionable slice, such as the failing assertion, type error, validator error, or review finding.
Because: Successful-check noise in context degrades agent performance as much as missing failure detail.

## ARCH-AGENCY-031: The review method is the one owner of reviewer sizing

The review method is the one owner of reviewer sizing. Prompts and workflows name the method and state no reviewer count of their own. For a small reversible change, fresh passing verification is the deterministic validator, and the method requires no independent reviewer.
Because: Two texts that size the review disagree, and the agent follows neither.
