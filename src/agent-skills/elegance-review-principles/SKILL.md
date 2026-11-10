---
description: Govern a code or plan review with feature-complete simplicity and structural elegance.
---

# Elegance Review Principles

{{if:skill:code-review}}
Apply this lens only with exactly one active review target. If neither target is active, load `code-review` for implemented code or `plan-review` for a settled plan. If both are active, stop and require the caller to select one. Return through the active target's locations, severity, and result contract.
{{else}}
Apply this lens only with exactly one active review target. If neither target is active, load `plan-review` for a settled plan, or review implemented code directly. If both are active, stop and require the caller to select one. Return through the active target's locations, severity, and result contract.
{{end}}

## Governing rule

{{if:type:reviewer}}
Explicit requirements and confirmed correctness, behavioral, security, data-integrity, and performance constraints are hard gates. Among remedies that satisfy those gates, choose the most elegant solution: the simplest feature-complete shape with the fewest owners, states, layers, abstractions, and failure branches. Do not count reviewer votes or union specialist remedies. An additive recommendation must use the smallest complete remedy.
{{else}}
Explicit requirements and confirmed correctness, behavioral, security, data-integrity, and performance constraints are hard gates. Among remedies that satisfy those gates, choose the most elegant solution: the simplest feature-complete shape with the fewest owners, states, layers, abstractions, and failure branches. Do not count votes or union specialist remedies. An additive recommendation must use the smallest complete remedy.
{{end}}

## Scrutiny

- Keep one source of truth for each value. Derive dependent views instead of copying or manually synchronizing state.
- Work with the language, runtime, framework, and project grain. Prefer native capability and established project mechanisms over wrappers or reimplementations.
- Make abstractions deep enough to hide complexity. Remove forwarding chains, shallow wrappers, and interfaces with no concrete second use.
- Keep interfaces narrow and ownership complete. A caller must not understand or coordinate another module's internals.
- Preserve dependency direction, layer boundaries, one-direction data flow, and ordered resource lifecycle.
- Reject speculative code, compatibility paths without consumers, hypothetical hardening, and elements whose deletion changes no required behavior. Concrete signals: a branch with no reachable producer, a tie-breaker for a state prevented by construction, race protection contradicted by actual ownership or serialization, validation repeated after a trusted boundary, a fallback that conceals an invariant violation, and configuration that exists only to preserve hypothetical flexibility.
- Report any defensive element the design or code adds for a risk the user did not state and that the design does not disclose with evidence. Missing disclosure is a finding even when the defense turns out to be justified.
- Tolerate local duplication until a real shared abstraction is evident. Extract when reuse or cohesive ownership is concrete, not to satisfy a checklist.
- Treat clustered local symptoms as evidence of one structural defect and propose the coherent root correction.

## Catalog

Lead a structural finding's Failure with one of these names. A finding that leads with a catalog name is routed to a reshape of the affected code or plan milestone rather than a local patch, so the name is the first token.

| Name | Signal | Elegant alternative |
|---|---|---|
| **Single Source of Truth** | The same datum has two homes | Read from the canonical home; derive the rest |
| **Depth over Indirection** | A layer redistributes complexity instead of hiding it | Deepen the module or remove the layer |
| **Narrow Interfaces, Deep Modules** | A caller must know the internals to use the surface | Hide the internals behind a simple surface |
| **One-Direction Data Flow** | A updates B and B updates A | Pick one owner; derive the other side |
| **Dead Code Is Debt** | Removing the code changes no behavior | Delete it |
| **God Class** | Class/module with 3+ unrelated responsibilities | Split by responsibility |
| **Shallow Wrapper** | Wraps an API, adds no new capability | Call the API directly |
| **Forwarding Chain** | A calls B calls C, B just delegates | A calls C directly, or A writes state C reads |
| **Parallel State** | Same value stored in two places | Single source of truth, derive the rest |
| **Speculative Code** | Built for hypothetical future requirements | Delete it. Add when needed. |
| **Config Soup** | Many optional fields, valid combinations unclear | Discriminated variants or composable primitives |
| **Stubborn Duplication** | Same logic in 3+ places, drift already starting | Extract; the abstraction is now clear from the call sites. |
| **Manual Sync** | Code that copies a value between representations | Derive the dependent value from the source |
| **Bidirectional Coupling** | A depends on B, B depends on A | Shared abstraction or invert one direction |
| **Cascade Mutation** | State update triggers chain of side effects | Compute derived values declaratively |
| **Leaky Event** | Producer filters/transforms events for specific consumers | Emit raw events; consumers own their filtering |
| **Premature Abstraction** | Generic base/interface with one implementation, no extension plan | Inline it. Extract when the second consumer appears. |
| **Leaky Interface** | Consumer must understand internals to use correctly | Deep module with self-documenting interface |
| **Comments-as-Apology** | Code needs prose to explain itself | Rename and restructure until the code reads itself. Comments only for non-obvious WHY. |
| **Indirection Tax** | Layer exists only to satisfy a rule, no value added | Remove the layer. Question the rule. |
| **Concrete Dependency** | Business logic imports infrastructure directly | Depend on abstraction, inject the impl |

{{if:type:reviewer}}
This package supplies principles only. Do not acquire target evidence, assign severity or locations, select reviewers, route workflow work, or combine findings.
{{else}}
This package supplies principles only. Do not acquire target evidence, assign severity or locations, route workflow work, or combine findings.
{{end}}