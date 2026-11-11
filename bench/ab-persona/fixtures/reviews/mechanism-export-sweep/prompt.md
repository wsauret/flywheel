Verify the behavioral claims that this implementation plan relies on.

PLAN:
plan.md lowers the retention of finished customer exports from 7 days to 24 hours and runs the sweeper every 10 minutes instead of every hour. Its section "Current behavior this plan relies on" states what the existing code does; the plan changes only two constants and adds metrics because of those statements. The project in this directory is the code before the plan.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the plan reviewers tagged these UNVERIFIED; trace each one through the current code before you give a verdict):
1. "An export that is still being written is never deleted by the sweeper, whatever its age, because the writer keeps the .partial name until the data is synced and renamed."
2. "Any file visible under its final .csv name has its full contents written and synced; a download never sees a partly written export under the final name."
3. "Two sweeps never run at the same time, also when one sweep takes longer than the interval."
4. "A download link for an export that the sweeper already deleted is answered with 404, not 500."
5. "Calling stop() on the sweeper while a sweep is running prevents any later sweep."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
