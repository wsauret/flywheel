---
description: Use when exercising a live user-facing surface outside-in through its public entry point.
---

# User Acceptance Testing

Start with acceptance criteria, a production-equivalent public entry point or target host package, environment constraints, credentials, and cost limits. Translate each criterion into an outside-in observable scenario without reading implementation code. Confirm safe drive mechanics, run the narrowest real path fresh, provide one input at a time, observe before continuing, and record interaction, environment, expected result, actual result, and durable evidence. Exercise an adjacent or error path only when it can change acceptance.

Every artifact the drive produces, including screenshots, recordings, logs, probe pages, and captured output, goes in the session scratch directory, never in the working tree of the repository under test. Many capture tools write to the current directory by default, so give each one an explicit absolute output path inside the scratch directory.

Stop when every criterion is `passed`, `failed`, or `blocked`, one critical failure makes further work wasteful, or the stated boundary is reached. Return per-criterion status, exact reproduction, observations, evidence locations, untested scope, and blockers.

Missing runtime, authentication, dependency, safe environment, safe drive mechanics, or host produces `blocked`, not a pass. Scripted tests support but never replace direct observation of an exercisable surface.

## The Real Operation

A surface is exercised only when its production code path runs end to end: every outbound call, every database mutation, every billable side effect a real user triggers. Isolate state where you can (a per-run sandbox directory, an isolated `$HOME`, a scoped database schema, a test inbox) so the drive does not pollute the developer's real local data, but isolation of state is not the same as faking the operation. Only the local state container is scoped; the services the product is configured for are exercised against their real endpoints.

Mocks, fakes, stubs, fixtures, in-memory adapters, sandbox-provider URLs, dry-run flags, frozen clocks, recorded-cassette replay, and provider-mocking middleware are silent downgrades unless they are the production code path. Inspect the configuration the product runs with (environment variables, config file, resolved client URLs, the credential the runtime picked up) and confirm the drive routes through the same backend a real user's instance would. If it does not, you are exercising a different product.

The stated cost limits bound what you may spend. Inside them, a credential that is present and that the product would use in normal operation is not off-limits; treating it as off-limits is a silent downgrade. When credentials are present and the operation is recoverable, the default is to execute. When you are uncertain whether a billable or irreversible operation is authorized, ask the user once before defaulting to skip. An operation the user has not authorized against shared production data is `blocked` with the specific blocker recorded, not a quiet downgrade.

## Depth of Proof

Treat the rendered or returned state as a hypothesis that the system did what the UI claims. Push each scenario as far down this ladder as the surface allows, and stop only when an attempted deeper level meets a hard blocker:

1. Observed state: drive the surface in the live product and observe the behavior.
2. Local source of truth: inspect the backing config, session, artifact, log, trace, or database row the action mutated and confirm it matches what was observed. The display does not prove the underlying state changed.
3. Subsequent consumption: perform the next real action that should consume the new state and confirm it used the changed value. Persistence without consumption is incomplete proof.
4. External dependency: when behavior depends on a provider account, API, remote service, clipboard, subprocess, or OS resource, perform a minimal direct probe. Never print secrets.
5. Negative or control path: confirm unavailable, disabled, or unsupported variants are truly unavailable, and that stale caches, old sessions, and unrelated defaults do not leak into the current result.

For each scenario, ask at least one question from each class, or record the observed proof that the class cannot apply: does the rendered state match the backing artifact; does the persisted change affect the next consumer; is the external dependency configured and usable here; does the producer's output match the consumer's contract (schemas, IDs, paths, status codes); what should not appear, not be selectable, not run; and can a user complete the intended job, not only operate the controls.

A drive that produces no observable difference between the state before and after the input is not a verification. "Key consumed without crash" and "did not error" prove nothing; when before and after are indistinguishable, the surface was not exercised.
