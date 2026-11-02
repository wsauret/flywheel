---
name: Raindrop Audit
description: Audit one Raindrop bookmark against Flywheel using the audit playbook, then emit the batched improvement proposals.
dependencies: [fly.raindrop-audit]
output: ../contracts/raindrop-audit.json
---

# Raindrop Audit Handoff

Run the `fly.raindrop-audit` package composed above for one bookmark, then hand off its result.

Before you call the handoff tool, write a full summary of what was decided as a text update in the conversation: what the source claimed, what you audited, each proposal you are about to emit (or why you are emitting none), any plan written or updated, and what you dismissed and why. Write this summary first, then emit the handoff that encodes it.

Emit one handoff with the fields that the output contract of your brief declares:

- `provenance`: `source_type`, `bookmark_id`, and `source_url` for every audit. A GitHub source also carries `local_clone` (the workspace-relative clone path below `inspiration/raindrop/`) and `source_commit` (the full 40-character lowercase commit hash of that clone). Validation resolves the clone from the working directory, so the clone must still be there and must contain that commit.
- `plan_artifacts`: one entry per research or plan artifact you wrote, as `{ path, disposition, summary }`. Each `path` is relative to the working directory. Exactly one `docs/research/*.md` research artifact is required and validation checks every listed file exists; a `docs/plans/*.md` entry appears only for a proposal outcome. Do not list the companion `docs/plans/README.md` roster edit as an artifact. Validation checks that each listed plan has exactly one link in `docs/plans/README.md`.
- `definition_proposals`: definition improvement proposals for a brief, workflow, schema, rubric, validator, test, instruction, or ADR the source shows is wrong or missing. Empty is valid.
- `summary`: what the source claimed, which capabilities you judged better, and what you dismissed and why.

A no-op audit with empty proposal arrays is a successful outcome. A shallow audit is not: if you cannot satisfy the source coverage gate, follow the playbook's blocked path instead of emitting a thin audit.

Completion guard: never send a final response before a valid handoff call succeeds (empty-queue stop above is the one exception). While the audit is incomplete, use progress updates only and continue with tool calls. Before calling handoff, verify that exactly one research artifact exists, every listed artifact path exists, and every listed plan has exactly one link in `docs/plans/README.md`.
