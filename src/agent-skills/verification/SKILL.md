---
description: Use for the smallest complete verification of a change.
---

# Verification

Use the smallest complete verification of the work, then stop. Start with the changed behavior and acceptance requirements, not an inventory of everything that could be tested.

Choose the fewest focused checks that prove the change. Tests alone are sufficient when they establish the required behavior. A test that mocks an external boundary does not prove that boundary: when the change touches a live service, a dependency's behavior, or a real entrypoint, a throwaway probe against the real thing is the gap tests cannot cover, and it belongs in the selected checks. Use UAT beyond that only for a specific gap or an explicit acceptance requirement. Honor explicit repository gates. Do not add broader suites, adjacent scenarios, or verification agents without a concrete evidence gap.

For ordinary changes, prefer unit tests plus a dedicated testing script that exercises the changed behavior through its real boundary. Do not assume integration tests exist or that their name implies a particular cost or scope. If repository instructions specify test tiers, required gates, or execution rules, follow them. Otherwise, use this default.

Assume past observations are stale. Prior test output, subagent results, and review reports can guide the checks but do not prove the current state. Run the selected checks yourself against the current implementation, then read their output and exit status. A new verification pass requires fresh observations; do not accept an earlier run because no change is known. Minimal verification means the smallest decisive fresh check, not recycled evidence.

Stop as soon as required evidence is complete, or report a failure or unavailable prerequisite. Keep the result short: checks run, outcomes, and any remaining uncertainty. Use a claim table only when distinct requirements need it. Do not turn a small change into an exhaustive verification campaign.

When the work rests on a causal explanation, such as a defect fix, state confidence as High when the full causal chain is confirmed with a tested prediction, Medium when the chain is complete but no independent prediction was tested, and Low when the fix is the best available and uncertainty remains. Confidence is Low while a decisive check is unavailable.

A failed command is a failure unless proven unrelated. An unavailable tool, environment, credential, or surface produces `unavailable` with the missing prerequisite, closest equivalent actually run, its result, and remaining uncertainty. Never infer success, edit the artifact, retry a fix, or change what is under proof.

Before changing anything, run the baseline checks once and record their result. A failing baseline is baseline evidence, not a finding you introduced, and it is the only way to tell a pre-existing failure from one your change caused.

## Judging Another Agent's Verification Claim

A claim of "verified" from a subagent, a reviewer, or an earlier pass is itself a hypothesis. Read the cited evidence, not the verdict, and look for these smells:

- The cited evidence does not demonstrate the claim: the artifact shows a different session, a different state, or nothing of the sort.
- "Verified" rests on no observable change or on "consumed without crash" reasoning; the observation only restates that the input was sent.
- A runtime behavior claim is backed by a `src/` path or "correct per some file" instead of an observation of the running product.
- Unexpected behavior is explained away as "by design" or "correct per X" without a user-visible confirmation; the verdict depends on the agent's interpretation rather than on what the product showed.
- Coverage gaps: every item was checked individually but no end-to-end path was run, one viewport, one runtime configuration, or one provider stood in for all of them.
- Shared evidence: two items that claim different behaviors cite the same artifact or the same observation, so at least one of them was not exercised.

When a smell is present, re-observe the behavior yourself or treat the claim as unproven.