Verify the behavioral claims that this completed change relies on.

CHANGE:
Team clients used to poll for roster changes. This change adds an in-process event bus (bus.ts) and a notifier (notifier.ts) that pushes member.added and member.removed events to the team's connected clients, which then refetch the roster. It also chains audit appends per team (audit.ts). The change is in diff.patch; the project in this directory is the code after the change.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the domain review tagged these UNVERIFIED; trace each one through the code before you give a verdict):
1. "Clients receive member.added only after the membership transaction has committed, because the bus defers delivery; if the commit fails and the transaction rolls back, no client is notified."
2. "Audit entries for one team reach the sink in the order record() was called, even when an earlier append is slower than a later one, and a failed append does not stop later entries for that team."
3. "If the membership transaction throws, no audit entry is written for that change."
4. "removeMember for a user who is not a member of the team emits no event and writes no audit entry."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
