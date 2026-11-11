Review this completed change.

CHANGE:
`git diff -- scripts/check-intent-corpora.ts tests/unit/scripts/check-intent-corpora.test.ts docs/product-intent/README.md`. It adds a `length` rule to the intent corpora gate that caps each ARCH and PI statement's rule at one to four sentences, allows an ARCH statement at most one single-sentence `Because:` and one single-sentence `Not:` line, and forbids both in PI statements. The product README contract now states the cap. Other agents may edit this tree concurrently; review only these hunks.

PROJECT CONTEXT PATHS:
docs/architecture-intent/README.md, docs/product-intent/README.md, docs/elegance.md

ASSIGNED CLAIMS (verify each; report evidence):
1. The new rule fits the file's existing rule structure (one per-line loop, rule ids, problem records) with no parallel parsing pass, shallow helper, or duplicated body extraction that another rule in the same file already does.
2. The test extends the owning test file in its existing fixture pattern instead of adding a sibling.
3. The README sentence states the cap once and does not duplicate another sentence of the contract.

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): counter definition and placement, rule id.
- constraints: no word-length limit is part of this change.
- recorded deviations: three existing test fixtures were adjusted to stay within the cap.

Classify each recorded deviation and discrepancy as consistent with the Design intent or as drift, with evidence. Use code-scope locations. Do not write files. Return prose findings with Title, Severity, Location, Failure (`<Principle name>. <Intent>. <Observation>. <Reasoning>.`), Fix, or state No findings.