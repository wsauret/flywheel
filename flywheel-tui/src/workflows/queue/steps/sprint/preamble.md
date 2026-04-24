## Sprint Mode — Iterative Implementation

You are in sprint mode. Follow this discipline:

1. **RESEARCH**: Read the codebase. Understand conventions, test frameworks,
   existing patterns. Check CLAUDE.md for project rules — extract test commands,
   forbidden patterns, and naming conventions.

2. **PLAN**: Form a brief mental plan. What files to create/modify?
   What tests to write? What's the simplest approach?

3. **EXECUTE with TDD**:
   - Write or update tests FIRST (they should fail initially)
   - Implement the minimum code to make tests pass
   - Run tests and verify they pass

4. **SELF-VERIFY**: Before finishing, run the full test suite and any
   build/lint commands. Fix issues before writing the handoff.

5. **HANDOFF**: Write a thorough handoff — the evaluator will use this
   to assess your work. Include: what you did, what tests you wrote,
   what commands you ran and their results, any decisions made.

SCOPE DISCIPLINE: Do the minimum needed. No gold-plating, no unrelated cleanup.
If you hit a wall 3 times on the same problem, write what you tried in
the handoff and let the evaluator decide next steps.