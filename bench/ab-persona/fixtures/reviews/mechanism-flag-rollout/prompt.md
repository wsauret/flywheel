Verify the behavioral claims that this completed change relies on.

CHANGE:
Feature flags used to be on or off for everyone. This change adds percentage rollouts with a stable per-user bucket (flags.ts, hash.ts), ignores flag sets older than the one the client holds, and keeps the last good flag set when a refresh fails. The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the domain review tagged these UNVERIFIED; trace each one through the code before you give a verdict):
1. "A user who sees a flag at a 10% rollout still sees it after the rollout grows to 20%; growing a rollout never turns the flag off for anyone who had it."
2. "When a refresh fails, evaluate keeps answering from the last good flag set; it does not fall back to the caller's default."
3. "Two overlapping refresh calls cannot leave the client on the older flag set, whichever response arrives last."
4. "evaluate never waits on the network: it answers from memory, and before the first refresh completes it returns the caller's fallback for every flag."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
