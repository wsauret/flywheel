Verify the behavioral claims that this implementation plan relies on.

PLAN:
plan.md adds wallet-to-wallet transfers with a flat fee, posted as one three-posting ledger entry, and a POST /transfers endpoint. Its section "Current behavior this plan relies on" states what the existing code does; the plan omits compensation logic and answers 200 as soon as the entry is posted because of those statements. The project in this directory is the code before the plan.

PROJECT CONTEXT PATHS:
none

ASSIGNED CLAIMS (the plan reviewers tagged these UNVERIFIED; trace each one through the current code before you give a verdict):
1. "Ledger.apply is all-or-nothing: if any posting of an entry is rejected, including for insufficient funds, no balance changes."
2. "Once post(entry) resolves, the entry survives a process crash, because the ledger persists through SnapshotWriter on every applied entry."
3. "An account opened with overdraftLimit 0 can never end an apply with a negative balance, also when one entry debits it more than once."
4. "Account ids are case-insensitive and ignore surrounding spaces everywhere an id enters the book, so the endpoint can pass ' Alice ' through and it posts to the account opened as 'alice'."
5. "An entry that touches an account in another currency is rejected before any balance changes."

Return one entry per claim: the claim number, a verdict of confirmed, refuted, or uncertain, the causal trace that settles it, and exact file:line evidence for each decisive step. For an uncertain verdict, name the missing evidence. Do not assign severity and do not write files.
