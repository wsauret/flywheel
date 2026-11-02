---
name: Raindrop Audit
description: Run a Raindrop bookmark audit in a source-run chat.
user-invocable: false
---

# Raindrop Inspiration Audit

## Launch from chat

When a person asks for a Raindrop audit in a source run, launch the committed template with the `workflow` tool. Use `{ kind: "path", path: "src/orchestration/modules/development/raindrop-audit.workflow.yaml" }`. This path is relative to the Flywheel repository root, the working directory of a source run. Give the launch a description that names the bookmark if the person named one. Do not claim or audit the bookmark yourself.

If you are the agent inside the Raindrop audit workflow, skip this launch section and do the audit below.

## Audit

`references/raindrop-audit-playbook.md` in this package is the authority for this audit. Read it in full before you start and follow it end to end: queue state and tags, the bookmark note and audit mode, every audit gate, the article and GitHub flows, the research-artifact template, and the invalid-audit conditions. This package adds only the scope and the write boundary. It does not restate the playbook and it never relaxes it.

## Scope

Audit ONE bookmark. Audit the bookmark the user named; with none named, claim the first item of the default queue.

If the default queue is empty, there is no unread work. Do NOT emit a handoff: every audit handoff carries the provenance of one real bookmark, so there is nothing honest to emit and there is no such thing as a bookmark-less audit. Do not fall back to recent or already-processed bookmarks. Report the empty queue to your parent with `message_session`, ask which bookmark to audit, and wait for its reply; audit the bookmark the reply names, or stop with no handoff when the reply has no work for you.

## Path Root

The working directory in the `<env>` block is the workspace root for this audit. Write `docs/` and `inspiration/raindrop/` below that directory. In tool calls, artifact text, and the handoff, use paths relative to that workspace, such as a file under `docs/research/` and a directory under `inspiration/raindrop/`. Do not write audit outputs at an enclosing Git repository root.

## What You May Write

- `docs/research/{date}-{slug}.md`: the research artifact. Every completed audit writes one.
- `private/plans/{slug}.md`: a new plan, or an update to the plan that already owns the target surface, and only when the playbook's gates allow a proposal. Plans are living documents: a bare topic slug, no date prefix (the `Date:` header carries the date).
- The plan index, `README.md` in `private/plans/`: update the index whenever the audit creates a new plan, and create it when it does not exist. Add one line in the correct section with the plan's canonical status and scope. Do not add a second entry when the audit updates an existing plan.

Nothing else. Do NOT write `private/improvements/` files: definition proposals travel in this handoff, and a deterministic consumer vets and records them after you finish. Do NOT edit a definition a proposal targets; `target_path` names the file the proposal is ABOUT, and it is never mutated.

Do not run `dev raindrop mark-analyzed`. The deterministic consumer records the audit outcome from this handoff. Claiming and, when you cannot finish, releasing the claim stay yours.
