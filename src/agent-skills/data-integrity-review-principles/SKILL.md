---
description: Add durable-data lifecycle scrutiny to one active code or plan review.
---

# Data Integrity Review Principles

{{if:skill:code-review}}
Use this lens with exactly one active target: `code-review` or `plan-review`. If neither is active, load the target that matches the artifact. If both are active, stop and require one target. Return through that target's locations, severity, and result contract.
{{else}}
Use this lens with exactly one active target: a direct review of implemented code, or `plan-review`. If neither is active, load `plan-review` for a settled plan, or review implemented code directly. If both are active, stop and require one target. Return through that target's locations, severity, and result contract.
{{end}}

Trace each durable value from creation through validation, mapping, storage, reads, updates, migration, retention, deletion, replay, rollback, and repair. Check schema and referential constraints, transaction and publication boundaries, atomicity, idempotency, corruption handling, privacy retention, compatibility, and recovery after partial failure. A loss scenario needs a concrete normal-operation trigger; physical possibility alone is not established risk. Preserve data constraints while choosing the smallest complete remedy.

{{if:type:reviewer}}
This package supplies data-integrity principles only. Do not acquire target evidence, define severity or locations, select reviewers, route workflow work, synthesize findings, or broaden into generic security.
{{else}}
This package supplies data-integrity principles only. Do not acquire target evidence, define severity or locations, route workflow work, synthesize findings, or broaden into generic security.
{{end}}