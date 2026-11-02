---
name: delegate-code
description: Delegate code-writing to implementer subagents and own the design, review, and verification.
disable-model-invocation: true
---

# Delegate code

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

Delegate code-writing to a subagent using the `implementer` persona with a specific scope (file paths, named data shape and its organizing structure, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.

## Subagents

**Use persona `implementer` for any code-writing subagent you spawn** (code-writing delegates, ad-hoc helpers).

**Defaults for every `subagent` call.** File pointers, not inlined context.

You own every subagent's work. Review the diff and write your own summary, don't pass through what it said. A second opinion is the same prompt against a different model. Agreement is high-signal.

**Fresh subagents by default.** Give new work to a fresh subagent with consolidated scope, meaning the original brief, every later directive, and the prior agent's report and branch. This holds for a fix round, a follow-up, a retry, and the next queue item. Resume, message, or queue a follow-up on an existing subagent only when the new work strictly needs state that lives in that agent and is costly to move: its local checkout, its uncommitted changes, or a process it still runs, such as a dev server, a simulator, or a babysit watcher. A stop or hold order to a running agent is not reuse. A role such as a PR owner outlives its agent. Once that agent returns, a fresh agent takes the role's next round. Interrupt-chained resumes silently drop directives, so fire a fresh subagent with consolidated scope rather than trusting a "done" summary.
