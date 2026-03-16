# Ralph Mode: Stateless Agent Loops

**Philosophy:** Agent as stateless function. Fresh context each phase. State files are THE source of truth.

Named after [Ralph Wiggum](https://ghuntley.com/ralph/) - a "hilariously dumb" but effective solution to context window limits.

## When Ralph Mode Activates

Ralph mode is triggered when ANY of these conditions are true:

1. **Plan has >5 phases** - Long tasks benefit from periodic context refresh
2. **User invokes with `--ralph` flag** - Explicit request for stateless execution
3. **Context exceeds 50% and >2 phases remain** - Proactive compaction

## Ralph Checkpoint

After each phase checkpoint in Ralph mode:

### 1. Write Detailed State

Ensure state file has everything for cold resume:
- Current phase number
- All completed phases with summaries
- Key decisions (exhaustive)
- Learnings (patterns, gotchas)
- Code context (all files modified/created)
- Any blockers or decisions deferred

### 2. Suggest Context Clear

```
Phase [N] complete. Context is [X]% full with [M] phases remaining.

Recommend clearing context and saying "carry on" for optimal performance.

Your progress is saved in:
- State: [state_path]
- Session: .flywheel/session.md

Options:
1. Clear context now (Recommended) - Say "carry on" to resume
2. Continue without clearing - May degrade quality on later phases
```

### 3. If User Clears

New instance loads fresh, reads state, continues seamlessly.

## State File Completeness for Ralph

In Ralph mode, state file MUST contain:

```markdown
## Progress
- [x] Phase 1: [description] - [key outcome]
- [x] Phase 2: [description] - [key outcome]
- [ ] Phase 3: [description]

## Key Decisions
- Phase 1: [decision 1 with rationale]
- Phase 1: [decision 2]
- Phase 2: [decision 3]

## Learnings
- Phase 1: [pattern discovered - file:line]
- Phase 2: [gotcha found - explanation]

## Code Context
- Created: [file1], [file2]
- Modified: [file3], [file4]

## Current Working State
<!-- For Ralph resume - what was the agent working on? -->
- Last action: [what was just completed]
- Next action: [what should happen next]
- Open questions: [any pending decisions]
```
