---
description: Use in workflows to turn a settled design into an implementation-ready specification.
dependencies:
  - research
  - implementation-planning
---

# Implementation Specification

Input: one approved settled design with no open questions and the repository revision it applies to. Preserve every settled decision, requirement, non-goal, and acceptable outcome. This package owns the implementation-planning method only. It does not own workflow handoff schemas, artifact paths, tool routing, agent selection, or host orchestration.

## Ground the plan in the codebase

Use the composed research method before decomposition. Read the nearest implementation patterns, exact implementation seams, callers, registrations, tests, module boundaries, and project rules. Reuse work that already exists instead of planning a second copy. Verify every existing path and symbol cited by the specification.
Grounding confirms how to execute an already settled design. Prefer observed behavior over educated guesses: analyze representative data, run actual code paths, and write disposable proof-of-concept tests in workflow scratch when those can resolve a technical question. Code reading identifies what to test; it does not substitute for executable evidence. Resolve newly discovered technical uncertainty during specification and state any remaining inference explicitly. Do not turn that work into an implementation milestone or ask the implementer to choose among alternatives.

Map every requested behavior and success criterion to concrete implementation work and proof. If repository evidence contradicts a settled implementation detail, correct the specification when the approved behavior and architecture still hold.

## Every element earns its place

Apply this admission test to every milestone, task, scenario, criterion, directive, guard, capability, and mode:

- **Design-cited:** the settled design requests it. Cite the requirement ID when the design uses IDs.
- **Codebase-cited:** a concrete normal-operation trigger exists in the repository. Name its `file:line`, symbol, or caller.
- **Not admitted:** it does not belong in implementation work.

Write the rationale when admission is not self-evident, especially for defensive guards, unnamed capabilities, extra scenario variants, and criteria beyond settled acceptance. A hypothetical crash, hostile input, interrupted write, or degraded outcome is not a codebase citation. Record it as `Deferred hardening: <entry> - assumption: <one sentence>` instead of making it a task or scenario. Do not add speculative compatibility, robustness, abstraction, or future-use work.

## Converge on one feature-complete shape

The specification owns the implementation shape needed to deliver the whole settled feature. For trivial work, record `Single obvious shape - no alternative considered because <concrete reason>.` For nontrivial work, choose the maximally elegant feature-complete decomposition. Do not manufacture alternatives, but record any plausible alternative encountered as `Considered: <alternative>. Rejected because: <one concrete reason>.`

Explicit requirements and confirmed correctness, security, data-integrity, performance, and runtime constraints are hard gates. Among shapes that satisfy them, choose the one with the fewest owners, states, layers, abstractions, and failure branches. Reject wrappers, parallel state, forwarding chains, speculative structure, and defensive machinery without a design or repository citation. Simplicity never means omitting requested behavior.

## Shape milestones and verification

Shape the milestones, scenarios, and verification with the composed implementation-planning method. The section labeled `Design intent` in the launch input is the fixed tier; everything this specification adds is implementation design. Carry the label through unchanged so the implementer sees the same line. Implementation may revise implementation design, expand necessary files, and change milestone boundaries from new evidence while preserving the Design intent; do not turn estimates into approval gates. Message your parent with `message_session` only for a narrow user-owned choice, and wait for its reply. When repository evidence contradicts the approved design, message your parent with `message_session`, give the contradiction and its evidence, and wait for its reply.

## Enforce readiness

A workflow specification has no open questions and no implementation-time unknowns. Resolve newly discovered uncertainty inside the specification agent through repository inspection, focused research, or experiments. Do not create a milestone for discovery, experiment, spike, or proof-of-concept work, and do not ask the implementer to figure out how the system works.

The specification is ready only when every requirement and success criterion maps to implementation work and proof; every existing citation is verified; files, symbols, tests, scenarios, dependencies, and boundary contracts are concrete; each milestone fits one run and has fresh verification; global acceptance closes the complete feature; rationale records the selected shape; speculative work is absent or deferred; and no open questions remain.

Return the workflow consumer's implementation-ready specification shape. Do not define its handoff fields, artifact location, tool policy, reviewer dispatch, or host control flow here.