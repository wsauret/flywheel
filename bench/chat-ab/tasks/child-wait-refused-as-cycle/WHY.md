# child-wait-refused-as-cycle

Fix commit: `ee096dc91ddbb701c460069a5f684609528142a2` fix(sessions): let a child wait again on a parent that waits on its children

Base commit: `c2795c96fdbd1fc38f1895300a4d378a09bdd59e` (the parent of the fix).

## The bug

`message_session` with `wait: true` and no text opens a reply wait only if the addressee does not already wait on the sender (`waitsReach` in `src/orchestration/session/reply-waits.ts`). At the base, the cycle check also counted the park of a parent on its running children as an edge from parent to child. `observeSessionRun` (`src/orchestration/agent-runtime/session-run-observation.ts`) reports every park with `parked = activeBackgroundCount > 0`. So a parent that asked the person in prose and ended its turn while a child still ran was "parked on" that child. When the child then waited on the parent with no text, the check refused it as a cycle. The child asked again, and the parent got the same question twice.

The fix removes the park edge: only a chain of reply waits counts as a cycle. A parent's park on its children ends on any input from the person and when any other child finishes, so it cannot deadlock. The fix touches 3 source files and about 82 lines (mostly removal of the park bookkeeping).

## Why it is a fair task

The user sees a duplicated question and a refusal message. The cause spans the message tool, `session-messaging.ts`, `reply-waits.ts`, and the agent loop's park observation in `session-run-observation.ts`. The existing unit test for the "prose question" case passes because it reports the parent's yield with `parked: false`, which the real runtime never sends while a child runs. A solver must notice that difference and decide what really counts as a cycle, while keeping real reply-wait cycles refused.

## Acceptance tests

`acceptance/child-wait-on-parent.test.ts`, built on the repository's session-manager fixtures:

1. A child's wait with no text on a parent that parked on its running children opens, shows the parent as the child's open wait, and the parent's later reply ends it with no notice.
2. The prose-question case with the realistic park: the parent reads the child's question, asks the person, and parks while the child runs. The child's second wait with no text opens, sends nothing, and the parent's reply ends it.
3. A parent that reads the question and then parks on its children still ends the child's first wait with its last words.
4. A wait with no text on a session that waits on the waiter for a reply is refused, and a three-session cycle of reply waits cannot form.

The tests report the park as the base runtime does (`parked: true`). A release that no longer reads that field ignores it, and a missing `resumed()` hook is skipped. The tests use a store under `tmpdir()` that the fixtures remove. They make no network request and start no process.

## Sandbox notes

Same sandbox shape as the other production-history tasks: `bunfig.toml` (with `sandbox.patch` removing the `root` line), `.env.test`, the four workspace `package.json` files, and the two tokenizer assets.

## Validation evidence

- Base sandbox: `bun test acceptance` gave 3 pass, 2 fail (both failures are the refused wait).
- Base sandbox with the fix commit's `src` changes applied: 5 pass, 0 fail (three runs).
- No entry stayed in a fresh `TMPDIR` after the run.

## Design variant

- The session messaging layer must decide cycles using only open reply waits, including indirect chains.
- Remove the tracking of parents paused on children from the cycle decision instead of adding a special-case exception.
- Another child's completion can wake the parent, as can input from the person.
- Preserve the rule that a parent ending its turn or pausing after reading the question ends the first wait with its last words.
- The child must show that it waits on its parent, and the parent's reply must end the new wait once without an extra notification.
- Verification must use a parent paused with a child still running and cover a second wait that sends no new message.
