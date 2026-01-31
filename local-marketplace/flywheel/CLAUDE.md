# Flywheel Plugin Guidelines

Shared guidelines for all Flywheel skills and agents.

## Human Leverage Hierarchy

Focus human review effort on highest-leverage artifacts:

| Review Target | Prevents |
|---------------|----------|
| **Research** | Thousands of bad lines of code |
| **Plans** | Hundreds of bad lines of code |
| **Code** | Individual mistakes |

Bad research (misunderstanding codebase architecture, wrong file locations) compounds into a fundamentally flawed plan. A flawed plan generates code that solves the wrong problem or breaks existing patterns.

**This is why Flywheel requires human approval at research and plan boundaries** - catching errors early has exponentially more leverage than catching them in code review.

---

## Subagent Dispatch Guidelines

When invoking subagents via the Task tool, follow these patterns:

### Dispatch Template

```markdown
Task <agent-name>: "
## Goal
[1-2 sentence clear objective]

## Context
- Working on: [feature/task description]
- Key files: [list of paths, NOT contents]
- Specific questions:
  1. [Question 1]
  2. [Question 2]

## Required Output Format
Return findings in Compaction Output Format.

DO NOT include:
- Full file contents (paths only)
- Investigation logs or failed attempts
- Verbose explanations

Max response: 500 words / 1,500 tokens
"
```

### Key Rules

1. **Never send file contents** - Provide paths, let subagent read
2. **Never receive file contents** - Subagent returns paths with descriptions
3. **Request compaction format** - Structured output reduces context bloat
4. **Set output limits** - Max 500 words for research, 750 for analysis

### When to Spawn Subagents

| Spawn Subagent | Handle Inline |
|----------------|---------------|
| Tasks are truly independent (no shared state) | Failures may be related |
| High context cost (web research, doc gathering) | Need full system state understanding |
| Work is parallelizable without coordination | Exploratory (don't know what's broken yet) |
| >30 seconds of expected work | Agents would edit same files |
| Tangential to main task | Quick lookup or simple read |

### Output Token Limits

- Research subagents: Max 500 words
- Analysis subagents: Max 750 words
- Reviewers: Max 1,000 words
- Always require compaction format

---

## Test-First Development

Default methodology for implementation:

1. **Write test first** - Define behavior before code
2. **Watch it fail** - Confirm test fails for right reason
3. **Implement minimally** - Just enough to pass
4. **Watch it pass** - Confirm fix works
5. **Refactor safely** - Clean up with test safety net

Skip TDD for: pure refactoring, config changes, documentation.

For debugging: Find root cause first, then write regression test, then fix.

---

## Context Budget Advisory

At phase boundaries, assess context usage:

### Warning Signs

- Read >20 files in current phase
- Received >5 subagent outputs without consolidation
- Repeating context that could be referenced by path

### Mitigation Actions

1. **Spawn synthesis subagent** - Consolidate findings before continuing
2. **Archive to file** - Write details to state/context file, reference path only
3. **Use compaction format** - Require structured output from all subagents

### 40% Rule

Stay under ~40% context utilization for optimal performance. Heuristics:

- >10 research outputs = spawn consolidation subagent
- >20 file reads = archive findings to context file
- >3 phases of work = checkpoint state file

### Never Compact

These should remain in working context:

- Current goal/objective
- Active errors being debugged
- User's original request
- Key decisions made this session

---

## Archive Before Compact

**BLOCKING REQUIREMENT:** Before any summarization or compaction of working memory:

1. Verify state/context file exists
2. Write key findings to file
3. Preserve file paths (not contents)
4. Only then proceed with compaction

Failure to archive before compacting may result in lost work.

---

## Agent Shared Patterns

Common patterns used across multiple agents:

### Review Output Structure

All reviewer agents should identify issues by severity:

- **P1 (Critical)**: Blocks deployment, security vulnerability, data loss risk
- **P2 (Important)**: Should fix before merge, affects functionality
- **P3 (Nice to have)**: Improvement suggestions, style nits

### Research Output Structure

All research agents should return:

1. **End Goal** - What we're trying to achieve
2. **Approach** - Strategy selected
3. **Key Findings** - Max 15 items (overflow to file)
4. **Files Identified** - Max 20 paths (overflow to file)

### Error Handling

When an agent encounters errors:

1. Log the error with context
2. Continue with partial results if possible
3. Report failures in output summary
4. Let orchestrator decide on retry vs proceed
