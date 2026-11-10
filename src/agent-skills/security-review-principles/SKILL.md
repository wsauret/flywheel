---
description: Add trust-boundary and exploitability scrutiny to one active code or plan review.
---

# Security Review Principles

{{if:skill:code-review}}
Use this lens with exactly one active target: `code-review` or `plan-review`. If neither is active, load the target that matches the artifact. If both are active, stop and require one target. Return through that target's locations, severity, and result contract.
{{else}}
Use this lens with exactly one active target: a direct review of implemented code, or `plan-review`. If neither is active, load `plan-review` for a settled plan, or review implemented code directly. If both are active, stop and require one target. Return through that target's locations, severity, and result contract.
{{end}}

Map trust boundaries and identities. Check authentication, authorization, privilege changes, secret creation and exposure, untrusted input normalization, injection paths, filesystem and subprocess boundaries, abuse cases, and safe defaults. A finding needs a concrete path from an attacker-controlled source to impact; do not substitute a desired threat model for the system's actual one. Preserve confirmed security constraints through the smallest complete remedy.

{{if:type:reviewer}}
This package supplies security principles only. Do not acquire target evidence, define severity or locations, select reviewers, route workflow work, synthesize findings, or own generic retention policy.
{{else}}
This package supplies security principles only. Do not acquire target evidence, define severity or locations, route workflow work, synthesize findings, or own generic retention policy.
{{end}}