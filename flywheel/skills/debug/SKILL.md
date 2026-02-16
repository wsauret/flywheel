---
name: debug
description: Debug issues with iterative fix loop. Gathers problem description, investigates, then enters fix-verify cycle. Triggers on "debug", "fix this", "troubleshoot".
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - Task
  - AskUserQuestion
---

# Debug

Iterative debug loop: gather problem, investigate, fix loop (max 10 iterations) with verification after each fix.

---

## Phase 0: Goal Definition

Parse `$ARGUMENTS` for a problem description.

**If `$ARGUMENTS` is empty:**
- Use AskUserQuestion: "Describe the problem you're seeing. Include error messages, unexpected behavior, or what's broken."

**Check for active work session:**
- Read `.flywheel/session.md` — if it exists, warn the user:
  - "A work session is currently active. Debugging may conflict with in-progress work."
  - Use AskUserQuestion: "Continue debugging anyway? (yes/no)"
  - If no, stop.

**Get verification command:**
- Use AskUserQuestion: "What command reproduces or shows the problem? (e.g., `pytest tests/test_foo.py`, `npm test`, `curl ...`). Say 'none' for manual verification."

**If command provided:**
- Run the command to capture baseline output
- Truncate output to last 2000 characters
- Store as `BASELINE_OUTPUT`

**If "none":**
- Set `MANUAL_MODE = true`
- Skip baseline capture

---

## Phase 1: Investigation

Investigate inline (no subagent dispatch in V1).

### Gather Context

1. Read error output / `BASELINE_OUTPUT` carefully — identify file names, line numbers, error types
2. Search codebase for relevant files:
   ```bash
   # Use Grep to find error strings, function names, class names from the output
   # Use Glob to locate test files, config files, related modules
   ```
3. Check recent git changes:
   ```bash
   git log --oneline -10
   git diff
   git diff --cached
   ```

### Form Hypotheses

Produce 2-3 ranked hypotheses based on the evidence. Format each as:

```
Hypothesis N: <one-line summary>
Evidence: <what points to this>
Likelihood: High / Medium / Low
```

### Confirm Direction

Present hypotheses to user using AskUserQuestion:
- "Here are my hypotheses. Which should I pursue first? (number, or describe a different direction)"

---

## Phase 2: Fix Loop

```
ITERATION = 0
STRIKES = {}  # track failures per hypothesis
CURRENT_HYPOTHESIS = <user-selected hypothesis>

For each iteration (1 to 10):

  1. Implement ONE targeted fix
     - Minimum change needed
     - If fix requires >5 lines, explain why before implementing

  2. Verify:
     - Automated mode: run verification command, truncate to last 2000 chars
     - Manual mode: AskUserQuestion "Did this fix the problem? (describe what you see)"

  3. Evaluate:
     - If FIXED → go to Phase 3
     - If NOT FIXED → analyze new output, adjust approach

  4. Track strikes:
     - STRIKES[CURRENT_HYPOTHESIS] += 1
     - If STRIKES[CURRENT_HYPOTHESIS] >= 3 → move to next hypothesis

  5. If all hypotheses exhausted:
     - AskUserQuestion "All hypotheses exhausted. Describe what you're seeing or suggest a new direction."
     - Form new hypotheses from user input
```

### Fix Loop Rules

- **Minimum change**: Make the smallest fix needed. If a fix requires >5 lines, explain why before implementing.
- **No shotgun debugging**: Fix root causes. Do NOT make random changes hoping something works.
- **Changes accumulate**: Do NOT stash or revert changes between iterations. Changes build toward the solution.
- **3-Strike Protocol**: 3 failures on the same hypothesis means move to the next. See `flywheel-conventions/SKILL.md` for the full 3-Strike Error Protocol.
- **Escalation**: After 10 iterations or all hypotheses exhausted, escalate to user with a summary of everything tried.

### Escalation Summary Format

```
## Debug Escalation
- Problem: <original description>
- Iterations completed: N
- Hypotheses tested: <list>
- Changes made so far: <list of files modified>
- Current state: <what the verification command shows now>
- Recommendation: <next steps if any>
```

---

## Phase 3: Completion

### Summarize the Fix

Provide a clear summary:
- **Root cause**: What was wrong
- **Fix applied**: What changed and why
- **Verification**: Confirmation that the verification command passes

### Show Changes

```bash
git diff
```

### Offer Next Steps

Use AskUserQuestion with exactly 2 options:

1. **"Commit and compound (Recommended)"** — Commit changes via `/fly:ship`, then offer `/fly:compound` to document the debugging solution for future reference.
2. **"Done for now"** — Exit without committing. Changes remain in the working tree.

**If user picks option 1:**
- Invoke `/fly:ship` to commit and create PR
- Then offer: "Want to run `/fly:compound` to document this fix for future reference?"

**If user picks option 2:**
- Inform user that changes are uncommitted in the working tree
- Exit

---

## Key Principles

- **Verification command is your feedback loop** — trust it over assumptions
- **One fix per iteration** — small, targeted changes that isolate variables
- **Escalate, don't spin** — after 3 strikes on a hypothesis, move on
- **All user interaction happens here** — never dispatch AskUserQuestion to subagents
- **Read before editing** — always Read a file before modifying it
- **Preserve context** — keep `BASELINE_OUTPUT` for comparison throughout the session

---

## Anti-Patterns

- **Shotgun debugging** — random changes hoping something works
- **Skipping verification** — never claim "fixed" without running the verification command
- **Stashing between iterations** — changes accumulate, do not revert
- **AskUserQuestion in subagents** — only the orchestrator interacts with users
- **Fixing symptoms** — address root causes, not surface-level manifestations
- **Multi-fix iterations** — one change per iteration keeps the feedback loop tight
