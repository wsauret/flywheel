# provider-chain-plan: seeded defect rationale

This fixture is a real production plan (session 9765adef66e9, plan-create handoff at event position 5927334, 2026-07-29) reviewed against the real codebase at commit 7228f2a30, the workspace state when the production plan review ran. The sandbox is a `git archive` of that commit; nothing in the snapshot is synthetic. Seven defects were seeded by mutating the plan text. The embedded verbatim user description is authentic and untouched, so several defects are catchable both against the code and against the plan's own authoritative spec, exactly like a real plan review.

## retry-guard-misstated (key_files)

The original plan described retry.ts as the `attemptProducedEvidence` replay guard that failover must reuse. The mutation claims retry.ts "already replays a stream even after partial assistant output", so failover "can replay unconditionally". This is the exact opposite of what the code does, and the plan still lists llm-errors-retry.test.ts as "existing proof that a stream with emitted evidence is not replayed", so a reviewer who verifies claims catches the lie two ways.

## availability-in-infra (constraint + phase-3 files)

The original plan kept live availability in orchestration and stated the layering rationale explicitly. The mutation moves provider-availability.ts to src/infra/llm and has it reuse COPILOT_STATIC_HEADERS and the credential refresh helper from the orchestration Copilot adapter. infra imports nothing from src/, so the plan directs an import that check:boundaries rejects.

## provider-parallel-state (phase-1 t2 + constraints)

The original plan preserved provider omission as the canonical automatic state and recorded a Considered/Rejected note naming Parallel State for exactly this alternative. The mutation deletes the rejection and adopts the rejected design: persist the resolved chain head plus an `automatic: true` flag. The stored provider is derived state that goes stale and silently pins automatic roles at snapshot time.

## evidence-gate-dropped (phase-4 t1 + constraint)

The original plan advanced the chain only after a terminal quota failure with no emitted assistant or tool evidence. The mutation replays the full request "regardless of any partial output", justified by a fictitious claim that "the UI deduplicates rendered output blocks". No such dedup exists, replayed tool calls would execute twice, and the embedded user description still says failover replays "only when no durable response evidence has been emitted".

## rate-limit-failover (constraint + phase-3 t4 + phase-4 t1)

The original plan confined failover to the three terminal quota classes. The mutation adds `rate_limit_exceeded` as chain-advancing "to save wall clock". The embedded description explicitly keeps rate limits in the same-provider retry path and lists changing non-quota retry semantics as out of scope.

## cap-default-always-set (phase-2 t1)

The settled semantics: cap field absent = uncapped; 4000 is only a Settings-editor prefill. The mutation adds a schema-level `.default(4000)` and persists the defaulted section at startup. Every user without the setting silently gets Copilot budget-skipped at 4000 credits, and startup mutates config the user never wrote. Also the codebase-wide rule: no `.default()` on schema fields as a substitute for writer contracts.

## token-logged (phase-3 t2)

The original scenario asserted the plaintext GitHub token is never retained in logs or errors. The mutation requires logging the full outgoing quota-poll request including the Authorization header at debug level, which writes the credential into the global log file, violating the Redacted policy the plan restates elsewhere.
