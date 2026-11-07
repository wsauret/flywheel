## Research Protocol

{{if:subagent}}
**Gate:** start from the supplied evidence: a map, an earlier phase's output, or files named in the request. Treat that ground as known. Check a supplied claim only when the work depends on it. Identify the facets that this evidence leaves open, and send explorers only for those gaps. This gate alone owns research breadth.

If no gap remains, do not dispatch explorers. For known territory that needs only a few targeted reads or searches, investigate inline. Send one explorer when a single gap needs more digging; use the facet dispatch below for broad or unfamiliar gaps. You can read target files while explorers run, but do not repeat an explorer's facet.

When a remaining gap depends on external sources (library docs, upstream issues, version constraints), dispatch an explorer for that specific question. Fold its citations into consolidation.

### Explorer Dispatch: One Explorer per Facet

For this dispatch, the topic includes only the gaps left open by the gate.

Split the topic into 2-5 disjoint facets - subsystems, layers, or questions that partition the search space. Dispatch one `explorer` per facet in its enumerative mode, all in one turn.

Each brief names the facet, demands enumeration before reading, and carries the flag checklist:

```
Topic: <topic>

Research this facet exhaustively: <one slice of the topic>.

Enumerate first: find every location plausibly relevant to this facet (<implementation files | pattern instances at file:line | docs and ADRs - whichever fit the facet>). Bias toward inclusion; do not stop at the first hits. Then read what you enumerated, filter the false positives, and document what exists with file:line citations for every claim.

Flag (only when present; do not invent):
- EXISTING_SOLUTION - code that already covers the topic
- PATTERN_CONFLICT - established conventions the topic would deviate from
- DRY_VIOLATION - duplicated logic across the analyzed inputs
- INTEGRATION_RISK - consumers or tests that changes would impact
- OPEN_QUESTION - ambiguities or multiple plausible interpretations
- CLAIM_INVALID - external source contradicts an assumption
- VERSION_ISSUE - referenced version is deprecated or has breaking changes

Documentarian mode - document what exists, do not suggest changes.
```

### Dispatch hygiene

- **Model:** explorers run on their own configured cheaper model; never set `model` on a dispatch. Implementation subagents (`implementer`, `general`) inherit the parent model.
- **Input:** pass file paths, not file content - every explorer reads for itself. Send the phase-only excerpt of a plan rather than the whole plan, under 100 lines where possible.
{{else}}
**Gate:** start from the supplied evidence: a map, an earlier phase's output, or files named in the request. Treat that ground as known. Check a supplied claim only when the work depends on it. Identify the facets that this evidence leaves open, and investigate only those gaps. This gate alone owns research breadth.

If no gap remains, stop investigating. Otherwise split the open gaps into 2-5 disjoint facets - subsystems, layers, or questions that partition the search space. Research each facet this way: enumerate first, finding every location plausibly relevant to it, biased toward inclusion. Then read what you enumerated, filter the false positives, and record what exists with file:line citations for every claim. When a gap depends on external sources (library docs, upstream issues, version constraints), answer that specific question from them and keep their citations.

Flag only what is present: EXISTING_SOLUTION (code that already covers the topic), PATTERN_CONFLICT (established conventions the topic would deviate from), DRY_VIOLATION (duplicated logic), INTEGRATION_RISK (consumers or tests that changes would impact), OPEN_QUESTION (ambiguities or multiple plausible interpretations), CLAIM_INVALID (an external source contradicts an assumption), and VERSION_ISSUE (a referenced version is deprecated or has breaking changes).
{{end}}
{{if:subagent|workflow}}
{{else}}

Research the facets one at a time.
{{end}}

### Consolidation

{{if:subagent}}
Combine explorer findings into one picture that answers the original question.
{{else}}
Combine the facet findings into one picture that answers the original question.
{{end}}

1. **Deduplicate** - the same file cited by multiple facets = 1 entry; keep the richest citation.
{{if:subagent}}
2. **Reconcile** - when facet findings disagree, or a flag from one facet contradicts another facet's claim, read the cited lines yourself before carrying the claim forward. Stitched per-facet briefs are the one place cross-facet contradictions arise; consolidation owns catching them.
{{else}}
2. **Reconcile** - when facet findings disagree, or a flag from one facet contradicts another facet's claim, read the cited lines again before carrying the claim forward.
{{end}}
3. **Carry flags forward** - every flag survives consolidation with its file:line citation so whoever acts on the findings can act on it.