---
description: Use when confirming and tracing a reported problem before any edit.
---

# Root-Cause Analysis

Start with the reported symptom, expected behavior, available runtime evidence, and reproduction constraints. Treat the report as the investigation request: extract the actual behavior, expected behavior, scope, supplied identifiers, constraints, and prior attempts from it, and do not ask the user to restate information that is already present. Do not ask the user for a reproduction or verification command. Running a command is optional evidence the investigator chooses; it is not an entry requirement and never a user responsibility. Research the repository and available runtime evidence first. Ask a question only when the expected behavior is materially ambiguous, when inaccessible external evidence is required to decide whether the behavior is a defect, or when the missing answer prevents a safe next action or risks repeating costly or destructive work.

Read focused tests and nearby examples to learn the intended contract. Supplied session, run, request, trace, or error identifiers point at the owning event store, trace store, or logs; persisted runtime evidence is a valid confirmation source.

Confirm the symptom with the strongest safe evidence. Trace backward from symptom to trigger across every causal edge. List assumptions at external and state boundaries, rank falsifiable hypotheses, test one prediction at a time, and update the causal chain only from observed evidence. Require a gap-free explanation before recommending a fix.

Use fresh observations from the current investigation to decide each hypothesis. Past observations guide hypotheses only, never current acceptance; do not assume they remain valid. Run the smallest fresh deciding experiment or inspection, including when the predicted result is that no change is needed.

Stop with one result:

- `confirmed`: trigger-to-symptom chain with evidence for every edge.
- `no-defect`: decisive evidence that the reported defect does not exist or that the requested behavior is already satisfied, including the inspected paths, observations, and why they settle the report.
- `blocked`: the exact missing evidence when the report cannot be confirmed.
- `exhausted`: hypotheses tested, observations, remaining uncertainty, and the next discriminating trace when further tests yield no new information.

Never edit code, claim a fix, or require a numeric retry quota. Do not use `no-defect` for inconclusive or inaccessible investigation.