# Verification Gates

Required checks before claiming completion.

## Verification Protocol

Before claiming any phase complete or expressing satisfaction:

1. **IDENTIFY**: What command proves this claim?
2. **RUN**: Execute FULL command fresh (not cached)
3. **READ**: Full output, check exit code, count failures
4. **VERIFY**: Does output confirm the claim?
5. **ONLY THEN**: Make the claim with evidence

---

## Banned Phrases Before Verification

Never say without evidence:
- "Done", "Fixed", "Complete", "Passing", "Working"
- "Should work", "Probably", "Seems to"
- "Great!", "Perfect!", "Looks good!"

---

## Evidence Requirements

| Claim | Required Proof |
|-------|----------------|
| Tests pass | Test output: 0 failures |
| Build works | Exit code 0 |
| Bug fixed | Red-green cycle verified |
| Feature implemented | Test exists + test output shows pass |
| Phase complete | All acceptance criteria checked |
| Feature works | Demo or test output |

---

## Two-Stage Review (Per Phase)

After implementation, before marking complete:

### Stage 1: Spec Compliance

- Did we build what was requested?
- Any missing requirements?
- Any extra/unneeded work?
- Verify by reading code, not trusting reports

**If Stage 1 fails:** Fix spec gaps first. Do not proceed to Stage 2.

### Stage 2: Code Quality

Only after Stage 1 passes:

- Is the code clean?
- Are there tests?
- Does it follow patterns?
- Any security concerns?

**If Stage 2 fails:** Fix quality issues. Re-run Stage 2.

---

## Test Commands

Auto-detect project type:

```bash
npm test || pytest || cargo test || go test ./...
```

Run after each phase checkpoint.

---

## Optional Reviewers

For complex changes (10+ files or security-sensitive):

```
Task code-simplicity-reviewer: "Review changes"
Task security-reviewer: "Check for vulnerabilities"
```

Run reviewers in parallel. Present findings.
