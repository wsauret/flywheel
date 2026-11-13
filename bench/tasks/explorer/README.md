# Explorer answer-key suite

Each folder is one codebase research question for the explorer persona. The harness loads every folder here in addition to the open-ended explorer tasks in `src/orchestration/modules/development/benchmark/catalog.ts`.

## Task folder

- `task.json`: `{ "id": <folder name>, "sandbox": { "commit": <full sha>, "paths": [...] } }`. The trial reads only that commit, from the repository root, restricted to those paths, as its whole project. The commit is a full 40-character commit ID; a short ID, a `<sha>:<subtree>` selector, or a tree ID is refused. Each path is literal, normalized, and repository-relative: no `.` or `..` segment, no empty segment or trailing `/`, no leading `:` (pathspec magic), and no `*`, `?`, `[`, `]`, or `\` (glob syntax). A path that is or lies under `bench` or `inspiration` is refused, so a trial can never read an answer key.
- `prompt.md`: the question. It names the behavior, never the file or symbol that holds the answer.
- `manifest.json` (optional): the answer key, `{ "facts": [{ "id", "claim", "catch_criteria", "files" }], "traps": [{ "id", "wrong_answer" }] }`. Without it a task is scored only by pairwise preference, exactly like the open-ended tasks.
- `WHY.md`: the origin of the question and, for each fact and trap, `path:line` evidence at the pin with a snippet that occurs on that line.

## Scoring

A run of a task with an answer key gets one judge call that returns the facts it caught, the facts it nearly caught (uncertain), and the traps it asserted as true. A mechanical check also counts each distinct `path:line` or `path:start-end` citation in the decoded handoff strings and the final text, and marks it invalid unless the path names exactly one file of the pin and 1 <= start <= end <= the file's line count. An absolute path names the pin file it ends with, because the trial reads a temporary copy; a relative path names the pin file it equals, or else the one pin file it is a trailing part of. Fact recall is the primary score, an asserted trap is a penalty, and pairwise preference stays the secondary score. The report shows all of them per task and per variant.

## Pilot and keep rule

A question is kept when claude-opus-5.5 medium (or high, when medium is under 70%) reaches at least 70% recall and some cheaper seat (gpt-6-luna high or claude-haiku-5.5 high) is under 50% recall or asserts a trap. Each pilot ran one repeat per seat, judged by gpt-6.1-sol xhigh, on the Personal profile with every candidate on a subscription. Recall is caught facts over key facts, per seat; "T" marks an asserted trap.

| Question | Pin | Luna | Haiku | Opus medium | Decision |
|---|---|---|---|---|---|
| concurrency-limit-quota | `b5833f6a` | 4/4 | 1/4 T | 4/4 | Kept (pilot 1) |
| resume-while-agent-opens | `b5833f6a` | 2/4 T | 2/4 T | 3/4 | Kept (pilot 1) |
| conversation-tree-reopen-fold: whether reopening a conversation after eight others refolds its history, what a factory passed to an already held key does, and what an earlier holder reads | `74d097f9` | 3/7 T | 6/7 | 6/7 | Kept (pilot 2) |

The three open-ended explorer tasks in `catalog.ts` stay in the catalog: retiring them needs 8 or more kept questions, and the kept set is 3.

## Dropped drafts

Pilot 1 (2026-11-13, pin `b5833f6a4e4458a80e02612cfb5c0729aaaaf267`) drafted questions that each named one recent fix. The code carries intent comments and statement IDs that point at each answer, so the cheap seats found them.

| Draft question | Luna | Haiku | Opus | Reason |
|---|---|---|---|---|
| thinking-row-wait: when the wait for a thinking block's signed row starts on the Claude subscription route, and what happens to later events | 4/4 | 4/4 | 4/4 | Saturated: every seat at 100% |
| reasoning-token-cost: how reasoning tokens are priced into recorded cost | 4/4 | 4/4 | 4/4 | Saturated |
| provider-candidate-order: the order in which one request tries its provider candidates | 4/4 | 4/4 | 4/4 | Saturated |
| background-wait-ceiling: default, ceiling, and over-ceiling behavior of a wait on background work | 5/5 | 5/5 | 5/5 | Saturated |
| compaction-above-trigger: what happens when the fresh context stays above the compaction trigger | 5/5 | 5/5 | 4/5 | No cheap seat under 50% or on the trap |
| escape-then-compact: whether an agent works again on its own after Escape and a compaction | 3/4 | 4/4 | 4/4 | No cheap seat under 50% or on the trap |
| large-read-bound: what bounds the output of a large file read | 3/4 | 4/4 | 4/4 | No cheap seat under 50% or on the trap |
| workflow-terminal-state: where a workflow's paused, completed, or failed state lives and how clients see it | 3/4 | 4/4 | 4/4 | No cheap seat under 50% or on the trap |
| late-interrupt-finished-subagent: what a late interrupt does to a finished subagent's result | 3/5 | 3/5 | 4/5 | Cheap seats at 60%, not under 50% |
| midstream-provider-5xx: how a 502 inside a started OpenAI-compatible stream is classified | 2/4 | 4/4 | 4/4 | Luna at exactly 50%, not under 50% |

Pilot 2 (2026-11-13, pin `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`) drafted questions that are harder by construction: each needs a trace across several files or subsystems, asks for an interaction, a condition, or a counterexample, has 5 to 7 facts, and has a trap that a nearby comment, name, or stated rule supports. Every fact and trap was checked mechanically against the pin before the pilot. Opus high ran where opus medium was under 70%.

| Draft question | Luna | Haiku | Opus medium | Opus high | Reason |
|---|---|---|---|---|---|
| compaction-during-capacity-wait: order of the save round, the context reset, and the capacity wait when compaction is due as every route reports a spent limit | 0/5 T | 1/5 T | 2/5 T | not run | Answer key defect: while a compaction plan is active the loop's settle callback stops the attempt (`agent-loop.ts:614`, `stop: ... compactionState.hasPlanned()`), so the failover quota branch that the key cites is not reached and the order depends on how many routes are marked spent. Opus medium found this; the key needs a rewrite before reuse |
| hosted-task-model-access-change: what a headless task on the Claude engine keeps and what its next request does after the lineup drops its model | 5/6 | 5/6 T | 6/6 T | not run | Answer key defect: the next request re-resolves the role and can move to another model, so the trap "moves to a model of the new lineup at its next request" is not wrong as stated |
| background-command-turn-end-wait: whether an agent keeps working over a running background command, what ends the wait, and over-hour or idle waits | 3/6 | 4/6 | 4/6 | 6/6 | Luna at exactly 50% and no trap asserted |
| unshown-session-resume-paths: what restarts an unfinished chat that no client shows, and what attaching and closing the last client do | 2/6 | 3/6 T | 3/6 | 3/6 | Opus under 70% at medium and high |
| edit-mixed-parameter-syntax: which mixed-syntax edit calls are applied, how old and new text are read, and what the streaming preview sees | 5/5 | 5/5 | 5/5 | not run | Saturated |
| prompt-cache-key-by-request-kind: body key and session headers per request kind on the OpenAI API and ChatGPT routes | 4/7 | 7/7 | 7/7 | not run | Luna at 57%, no trap asserted |
| role-config-prune-scope: what the model picker's configuration cleanup deletes and why a broken custom persona's role disappears | 4/6 | 6/6 | 6/6 T | not run | No cheap seat under 50% or on the trap |
| stop-during-signed-thinking-row: how long Stop takes while the Claude engine's signed thinking row is missing, and what the next message sends | 4/6 | 5/6 | 5/6 | not run | No cheap seat under 50% or on the trap |
| subagent-handoff-contract-failure: what a parent receives when a subagent's handoff keeps failing its contract, compared with a workflow agent | 5/6 | 5/6 | 5/6 | not run | No cheap seat under 50% or on the trap |
| unattended-spent-capacity-vs-chat: what an unattended run and a read chat do on a spent usage limit, and when the unattended run still waits | 5/6 | 6/6 | 6/6 | not run | No cheap seat under 50% or on the trap |
| unreadable-launch-link-subtree: whether a child counts in its parent's usage stats when one of its two lineage records is unreadable | 5/7 | 6/7 | 5/7 | not run | No cheap seat under 50% or on the trap |

Across pilot 2 the cheap seats were weaker than in pilot 1 (recall luna 62%, haiku 81%, opus medium 82%, against 82%, 86%, and 94%), but haiku high matched opus medium on almost every question, so only one draft separated the seats under the keep rule.
