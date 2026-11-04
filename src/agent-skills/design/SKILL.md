---
description: Use for feature feasibility or designing a change or fix.
---

# Design

Turn a change, fix, or feature into one approved design, then continue delivery.

## Input

Start with the requested change, known constraints, and available evidence. State the user-visible feature set first. For nontrivial work, give requirements stable IDs so later work can cite them.

A request to design, plan, brainstorm, or assess feasibility starts this process. When the requested outcome remains unmet and evidence supports a viable change, continue into delivery. A confirmed cause starts fix design, even when the remedy looks obvious; the diagnosis is evidence for the design, not the end of the task.

Pure information questions do not require implementation. Honor explicit advice-only or investigation-only limits. Design-only requires an explicit restriction such as "do not implement", "stop after the plan", or "I only want advice". Do not infer that restriction from a request to plan first.

## Method

Existing scope approval takes precedence over per-design approval. A request such as "fix all broken lint and tests" authorizes repairs in that scope before each cause or design is known. Independent fixes, newly discovered causes, and in-scope design revisions do not reset approval. An ordinary bug investigation still requires fix-design approval when no prior authorization covers the repair. Broad approval does not authorize weaker checks or changed product requirements. Tool consent requirements remain binding.

1. Spike before you design. Form hypotheses about feasibility and mechanism without presenting them, test them at once, and say what each test checks while it runs. A diagnosis or candidate design is a hypothesis, not a user requirement. State the deciding observation and its acceptance criterion for each material uncertainty, and skip an observation whose outcome cannot change the design. Prove a claim about what code does by citing the code; reading code settles nothing else. Every other load-bearing claim, such as end-to-end feasibility, a runtime mechanism, performance, or external behavior, rests on what a spike observed. Prefer observed behavior over educated guesses: analyze representative data, run actual code paths, and use disposable proof-of-concept tests and probes. A claim about an external service, a dependency, or runtime behavior is settled by a throwaway probe against the real thing. Prototype competing shapes only when inspection cannot tell the viable shapes apart. Your confidence after a code survey is never proof. A spike that disproves the approach changes the approach before you show any design, and a spike that shows the request is not feasible returns that finding with its evidence, and only evidence-supported alternatives, instead of a design. Past observations are stale: they choose the experiment and do not replace it. Before a paid experiment, state its spend and prove the setup with the smallest paid run. When a probe changes a premise, say so in the same turn; a change that contradicts a recorded constraint or user decision goes to the user. Trace every defensive element to the producer, loader, or ordering that makes its input reachable. A material risk you cannot settle from evidence is an open question for the user.
2. Set the scope ceiling and list non-goals and acceptable outcomes. Investigation findings are evidence, not automatic scope.
3. Surface every decision whose alternatives materially change cost or architecture. Resolve it from project authority or explicit user choice rather than an illustrative implementation detail.
4. Own every open question through closure: spike technical uncertainty, and ask the user when the answer depends on product intent, preferences, constraints, or acceptable tradeoffs.
5. Compare viable decompositions and select the simplest feature-complete shape supported by evidence. Close every rejected hypothesis with the evidence that rejected it, record each rejected alternative under the Design intent constraints as "Not X, because ..." with one concrete reason, in the user's own words when the user gave the reason, and name the riskiest remaining assumption and the observation that would show it wrong.
6. State ownership, boundaries, one-way data flow, failure behavior, and verification expectations. Prefer maximal elegance over minimal churn when both satisfy the feature set.
7. When evidence supports a change, select exactly one implementation route: inline, subagent, or a workflow file that you write when later agents read earlier results. Use the lightest route that can complete the approved design, sized by the `implementation` skill. Select an implementation workflow only when no open question remains and no milestone needs discovery, experiments, spikes, or proof-of-concept work. The approved design is the ceiling implementers may not change: fix intent and key decisions here, and leave files, milestones, and local shapes to the route.
8. Present the complete design and, when work remains, the recommended implementation route in your reply, never by pointing at a file. If existing scope approval covers the work, proceed without another approval prompt. Otherwise request approval: In the same turn, call `ask_user` with `Approve and continue`, `Advisor review first`, and `Revise design`. Mark `Revise design` with `requires_text: true`. A text answer that rejects the approach, not a detail, returns the work to step 1: spike again with the user's guidance before you present a new design. When you cannot tell a correction from a rethink, ask. On `Advisor review first`, ask the Advisor whether the design and route need a material change. When it recommends no material change, the selection conditionally approves the unchanged design and its route, and your reply states the Advisor's strongest objection and what would reverse its advice. When it raises a material concern, evaluate it, present the revised design or why it is unchanged, and ask again. When it fails or is unavailable, ask again without implied approval. Never treat a change that the Advisor proposed as approved. Do not silently promote optional hardening or verification into required scope.

## Challenge

When the user questions your explanation, says they are confused, or proposes a simpler model, first restate their model. Then name the exact premise where it differs from yours: a requirement, an assumption, or a tradeoff. Do not defend or concede by reflex. Weigh a simpler alternative against the same requirements. Settle a disputed fact with a code citation or the smallest spike that can change the decision, and leave a product priority or acceptable tradeoff to the user. The challenge ends when you show why your approach is better or give a justification that the user accepts. When the decision changes, update the checkpoint Design intent and every affected artifact before further delegation, and verify the affected behavior again; a revised explanation alone does not complete the revision.

## Reshape

When the user asks about the shape of published code, explain the code first. A local objection, such as a name, a misplaced function, or a missing case, is an ordinary fix: verify it and publish it to the same change. An objection to the structure starts a reshape: record the user's shape guidance as a dated decision, and treat the behavioral proof that the change already passed, its tests, probes, and measurements, as a fixed contract. Spike new structures under that guidance, and publish the reshaped code to the same change only after the same proof passes again. When you cannot tell a local objection from a structural one, ask.

## Result

Return one design headed **Design intent**. Approval fixes everything under that label. Store the intent and the user's dated decisions in the conversation checkpoint; mark it approved on user approval. The runtime carries approved intent and decisions to children read-only; do not copy them into launch descriptions, briefs, or reviewer prompts. Outside Design intent, evidence and illustration remain revisable. State decisions as outcomes and ownership, and name files or shapes only as decisions. Mark each part of Design intent that the user did not state `(inferred)`.

**Design intent**

1. **Purpose**: one or two sentences on what the work is for and which goal wins when two outcomes conflict; only the purpose decides tradeoffs that the design did not foresee.
2. **Feature set**
3. **Approach and key decisions**: a decision that the user made after the first request carries its date, the user's words, and the earlier decision it replaces.
4. **Non-goals / acceptable outcomes**
5. **Constraints**: include every rejected alternative as "Not X, because ...".
6. **Verification expectations**

**Evidence and illustration**

7. **Risks introduced by evidence, not by the user**: for each, the risk, the evidence that establishes it, the path through which it is reachable, and the complexity it adds to the design. Write `None.` when the design adds no defensive behavior beyond what the user asked for.
8. **Evidence**: for each load-bearing claim, the code citation or spike observation that supports it, and each claim that neither supports labeled untested theory. Add other observations, data, and any remaining inference.
9. **Illustration**: sketches, candidate files, and example shapes that show one way the intent could land. Write `None.` when there are none.

## Recommended implementation route

When evidence supports delivery, name exactly one route from Method with one short sizing reason. The route starts on approval; it is a delivery commitment, not a suggestion for later. Its units start together unless one waits for a prerequisite or a file another unit changes; name each wait. Approval covers the design and that route. Only an explicit design-only restriction makes the route advisory; then label it as not authorized for execution. When decisive evidence shows the work is unnecessary, state that and recommend no delivery route.

## Revision

Every route, inline included, returns a first draft; its recorded deviations are expected drift, not defects. You hold the design intent, so revise the draft with review evidence. Read its deviations and summary yourself, and realign structural drift before review. Start the review with the design, its constraints, and the deviations, and ask reviewers to report defects and to classify each deviation as consistent with the design or drift, with evidence. Judge each finding against the design and the original request: realign what missed the intent, keep what serves it better than the plan did, fix the defects, and verify with the smallest complete check. Revise until the verified draft realizes the approved design and adds nothing beyond it. When the draft shows that the approved design itself must change, present that change to the user as a design revision. A passed budget or dependency-owned cost does not authorize a repeatable measured regression outside the approved intent: report the gate result, regression, and cause separately, and let the person decide unless the approved intent already allows it.

## Stop and failure

A decisive no-change conclusion completes the request without approval or delivery. Design is complete when every material choice is fixed, no open questions remain, and existing scope approval or explicit design approval covers the work and route. Otherwise, the change is complete when the revised draft is verified and reviewed. Unless the user explicitly restricted the task to design-only, persist any approved product-intent changes and immediately execute the approved route through the host's delivery tools and consent rules. Do not stop at approval or intent publication, or make the user advance the process. After a revision, present the updated design and route; call `ask_user` again only when the result exceeds existing approval or introduces a user-owned decision.