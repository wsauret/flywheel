---
name: plan-deepening
description: Enhance existing plans with skills, learnings, and research agents. Spawns parallel sub-agents for maximum coverage. Triggers on "deepen plan", "enhance plan", "research plan".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
---

# Plan Deepening Skill

Enhance existing implementation plans with parallel research agents, skills, and documented learnings. Each major section gets dedicated research sub-agents to find best practices, performance optimizations, edge cases, and real-world implementation examples.

**Philosophy:** 20, 30, 40 skill sub-agents is fine - no limit. Use everything available. The goal is MAXIMUM coverage, not efficiency.

**Note: The current year is 2026.** Use this when searching for recent documentation and best practices.

## Input

The plan file path is provided via `$ARGUMENTS`. If empty:
1. Check for recent plans: `ls -la plans/`
2. Ask the user: "Which plan would you like to deepen? Please provide the path (e.g., `plans/my-feature.md`)."

Do not proceed until you have a valid plan file path.

---

## Phase 1: Parse and Analyze Plan Structure

Read the plan file and extract all major sections that can be enhanced with research.

### Extract Plan Components

Identify and document:
- [ ] Overview/Problem Statement
- [ ] Proposed Solution sections
- [ ] Technical Approach/Architecture
- [ ] Implementation phases/steps
- [ ] Code examples and file references
- [ ] Acceptance criteria
- [ ] Any UI/UX components mentioned
- [ ] Technologies/frameworks mentioned (Rails, React, Python, TypeScript, etc.)
- [ ] Domain areas (data models, APIs, UI, security, performance, etc.)

### Create Section Manifest

Build a manifest of sections to enhance:

```
Section 1: [Title] - [Brief description of what to research]
Section 2: [Title] - [Brief description of what to research]
Section 3: [Title] - [Brief description of what to research]
...
```

### Identify Technologies

Extract all technologies mentioned for targeted research:
- Programming languages (Python, TypeScript, Ruby, Go, etc.)
- Frameworks (React, Rails, Django, FastAPI, etc.)
- Libraries (React Query, SQLAlchemy, Prisma, etc.)
- Infrastructure (AWS, Docker, Kubernetes, etc.)
- Databases (PostgreSQL, Redis, MongoDB, etc.)

---

## Phase 2: Discover and Apply Available Skills (ALL 5 Sources)

**CRITICAL:** Dynamically discover all available skills from ALL sources and match them to plan sections. Don't assume what skills exist - discover them at runtime.

### Step 1: Discover ALL Available Skills

```bash
# 1. Project-local skills (highest priority - project-specific)
ls .claude/skills/ 2>/dev/null

# 2. User's global skills (~/.claude/)
ls ~/.claude/skills/ 2>/dev/null

# 3. Flywheel plugin skills
ls ~/.claude/plugins/cache/*/Flywheel/*/skills/ 2>/dev/null
# Also check compound-engineering variant
ls ~/.claude/plugins/cache/*/compound-engineering/*/skills/ 2>/dev/null

# 4. ALL other installed plugins - check every plugin for skills
find ~/.claude/plugins/cache -type d -name "skills" 2>/dev/null

# 5. Also check installed_plugins.json for all plugin locations
cat ~/.claude/plugins/installed_plugins.json 2>/dev/null
```

**Important:** Check EVERY source. Don't assume any plugin is the only source. Use skills from ANY installed plugin that's relevant.

### Step 2: Read Each Skill's Documentation

For each discovered skill directory, read its SKILL.md to understand capabilities:

```bash
# For each skill directory found, read its documentation
cat [skill-path]/SKILL.md
```

Build a skill catalog:
```
Skill: [name]
Path: [full path to skill directory]
Description: [from SKILL.md]
Matches plan sections: [list of relevant sections]
```

### Step 3: Match Skills to Plan Content

For each skill discovered:
- Read its SKILL.md description
- Check if any plan sections match the skill's domain
- If there's ANY possible match, include it for sub-agent spawning

**Be inclusive, not exclusive.** If a skill might apply, include it.

### Step 4: Spawn Sub-Agent for EVERY Matched Skill

**CRITICAL: For EACH skill that matches, spawn a separate sub-agent and instruct it to USE that skill.**

For each matched skill:
```
Task general-purpose: "You have the [skill-name] skill available at [skill-path].

YOUR JOB: Use this skill on the plan.

1. Read the skill: cat [skill-path]/SKILL.md
2. Follow the skill's instructions exactly
3. Apply the skill to this content:

---
[relevant plan section or full plan]
---

4. Return the skill's full output

The skill tells you what to do - follow it. Execute the skill completely."
```

**Spawn ALL skill sub-agents in PARALLEL:**
- 1 sub-agent per matched skill
- Each sub-agent reads and uses its assigned skill
- All run simultaneously
- **20, 30, 40 skill sub-agents is fine - NO LIMIT**

**Each sub-agent:**
1. Reads its skill's SKILL.md
2. Follows the skill's workflow/instructions
3. Applies the skill to the plan
4. Returns whatever the skill produces (code, recommendations, patterns, reviews, etc.)

**Example spawns:**
```
Task general-purpose: "Use the dhh-rails-style skill at ~/.claude/plugins/.../dhh-rails-style. Read SKILL.md and apply it to: [Rails sections of plan]"

Task general-purpose: "Use the frontend-design skill at ~/.claude/plugins/.../frontend-design. Read SKILL.md and apply it to: [UI sections of plan]"

Task general-purpose: "Use the agent-native-architecture skill at ~/.claude/plugins/.../agent-native-architecture. Read SKILL.md and apply it to: [agent/tool sections of plan]"

Task general-purpose: "Use the security-patterns skill at ~/.claude/skills/security-patterns. Read SKILL.md and apply it to: [full plan]"

Task general-purpose: "Use the performance-optimization skill at [path]. Read SKILL.md and apply it to: [performance-critical sections]"
```

**No limit on skill sub-agents. Spawn one for every skill that could possibly be relevant.**

---

## Phase 3: Discover and Apply Learnings/Solutions

Check for documented learnings from the /compound workflow. These are solved problems stored as markdown files. Apply institutional knowledge to prevent repeating past mistakes.

### Learnings Location - Check These Exact Folders

```
docs/solutions/           <-- PRIMARY: Project-level learnings
├── performance-issues/
│   └── *.md
├── debugging-patterns/
│   └── *.md
├── configuration-fixes/
│   └── *.md
├── integration-issues/
│   └── *.md
├── deployment-issues/
│   └── *.md
└── [other-categories]/
    └── *.md
```

### Step 1: Find ALL Learning Markdown Files

```bash
# PRIMARY LOCATION - Project learnings
find docs/solutions -name "*.md" -type f 2>/dev/null

# If docs/solutions doesn't exist, check alternate locations:
find .claude/docs -name "*.md" -type f 2>/dev/null
find ~/.claude/docs -name "*.md" -type f 2>/dev/null
```

### Step 2: Read Frontmatter of Each Learning to Filter

Each learning file has YAML frontmatter with metadata. Read the first ~20 lines of each file to get filtering information:

```yaml
---
title: "N+1 Query Fix for Briefs"
category: performance-issues
tags: [activerecord, n-plus-one, includes, eager-loading]
module: Briefs
symptom: "Slow page load, multiple queries in logs"
root_cause: "Missing includes on association"
---
```

**For each .md file, quickly scan its frontmatter:**

```bash
# Read first 20 lines of each learning (frontmatter + summary)
head -20 docs/solutions/**/*.md 2>/dev/null
```

### Step 3: Filter - Only Spawn Sub-Agents for LIKELY Relevant Learnings

Compare each learning's frontmatter against the plan:
- `tags:` - Do any tags match technologies/patterns in the plan?
- `category:` - Is this category relevant? (e.g., skip deployment-issues if plan is UI-only)
- `module:` - Does the plan touch this module?
- `symptom:` / `root_cause:` - Could this problem occur with the plan?

**SKIP learnings that are clearly not applicable:**
- Plan is frontend-only -> skip `database-migrations/` learnings
- Plan is Python -> skip `rails-specific/` learnings
- Plan has no auth -> skip `authentication-issues/` learnings

**SPAWN sub-agents for learnings that MIGHT apply:**
- Any tag overlap with plan technologies
- Same category as plan domain
- Similar patterns or concerns

### Step 4: Spawn Sub-Agents for Filtered Learnings

For each learning that passes the filter:

```
Task general-purpose: "
LEARNING FILE: [full path to .md file]

1. Read this learning file completely
2. This learning documents a previously solved problem

Check if this learning applies to this plan:

---
[full plan content]
---

If relevant:
- Explain specifically how it applies
- Quote the key insight or solution
- Suggest where/how to incorporate it

If NOT relevant after deeper analysis:
- Say 'Not applicable: [reason]'
"
```

**Example filtering:**
```
# Found 15 learning files, plan is about "Rails API caching"

# SPAWN (likely relevant):
docs/solutions/performance-issues/n-plus-one-queries.md      # tags: [activerecord]
docs/solutions/performance-issues/redis-cache-stampede.md    # tags: [caching, redis]
docs/solutions/configuration-fixes/redis-connection-pool.md  # tags: [redis]

# SKIP (clearly not applicable):
docs/solutions/deployment-issues/heroku-memory-quota.md      # not about caching
docs/solutions/frontend-issues/stimulus-race-condition.md    # plan is API, not frontend
docs/solutions/authentication-issues/jwt-expiry.md           # plan has no auth
```

**Spawn sub-agents in PARALLEL for all filtered learnings.**

**These learnings are institutional knowledge - applying them prevents repeating past mistakes.**

---

## Phase 4: Launch Per-Section Research Agents

For each major section in the plan, spawn dedicated sub-agents to research improvements using the Task Explore capability.

### Per-Section Research

For each identified section, launch parallel research:

```
Task Explore: "Research best practices, patterns, and real-world examples for: [section topic].

Technologies involved: [list from plan]

Find:
- Industry standards and conventions
- Performance considerations and optimizations
- Common pitfalls and how to avoid them
- Security considerations if applicable
- Edge cases and error handling patterns
- Documentation and tutorials
- Real-world implementation examples

Return concrete, actionable recommendations with code examples where possible."
```

### Context7 MCP Integration

For any technologies/frameworks mentioned in the plan, query Context7 for official documentation:

**Step 1: Resolve Library ID**
```
mcp__plugin_Flywheel_context7__resolve-library-id: {
  "libraryName": "[framework name]",
  "query": "[what you need to know about this framework for the plan]"
}
```

**Step 2: Query Documentation**
```
mcp__plugin_Flywheel_context7__query-docs: {
  "libraryId": "[resolved library ID]",
  "query": "[specific question about patterns, APIs, best practices]"
}
```

**Example Context7 queries:**
- React Query: "optimistic updates and cache invalidation patterns"
- Prisma: "transaction handling and error recovery"
- FastAPI: "dependency injection and middleware patterns"
- SQLAlchemy: "async session management and connection pooling"

### Web Search for Current Best Practices

Use WebSearch for recent (2025-2026) articles, blog posts, and documentation on topics in the plan:

```
WebSearch: "[technology] best practices 2026"
WebSearch: "[pattern] implementation examples"
WebSearch: "[framework] performance optimization guide"
```

### Launch ALL Research Agents in Parallel

**Do NOT serialize research. Launch ALL section researchers, Context7 queries, and web searches simultaneously.**

---

## Phase 5: Synthesize and Deduplicate Findings

Wait for ALL parallel agents to complete - skills, research agents, learnings, everything. Then synthesize all findings into a comprehensive enhancement.

### Collect Outputs from ALL Sources

1. **Skill-based sub-agents** - Each skill's full output (code examples, patterns, recommendations)
2. **Learnings/Solutions sub-agents** - Relevant documented learnings from /compound
3. **Research agents** - Best practices, documentation, real-world examples
4. **Context7 queries** - Framework documentation and patterns
5. **Web searches** - Current best practices and articles

### Extract from Each Agent's Findings

For each agent's output, extract:
- [ ] Concrete recommendations (actionable items)
- [ ] Code patterns and examples (copy-paste ready)
- [ ] Anti-patterns to avoid (warnings)
- [ ] Performance considerations (metrics, benchmarks)
- [ ] Security considerations (vulnerabilities, mitigations)
- [ ] Edge cases discovered (handling strategies)
- [ ] Documentation links (references)
- [ ] Skill-specific patterns (from matched skills)
- [ ] Relevant learnings (past solutions that apply)

### Deduplication Algorithm

**Identical findings:** Same recommendation from multiple sources
- Merge into single finding
- Note source count: "Recommended by 4 agents"
- Higher confidence when multiple sources agree

**Similar findings:** Same topic, different wording
- Group under common theme
- Preserve unique details from each
- Create consolidated recommendation

**Complementary findings:** Different aspects of same topic
- Keep both, organize as related
- Cross-reference each other

**Conflicting findings:** Contradictory recommendations
- Mark clearly as CONFLICT
- Present both sides with reasoning
- Note which agents support each side
- Let user decide resolution

### Prioritize by Impact

**High Impact:**
- Security vulnerabilities or mitigations
- Performance improvements with measurable gains
- Architecture decisions with long-term consequences
- Patterns from multiple agreeing sources

**Medium Impact:**
- Best practices with clear benefits
- Edge case handling
- Code quality improvements
- Documentation requirements

**Lower Impact:**
- Minor optimizations
- Style preferences
- Nice-to-have enhancements

### Group by Plan Section

Organize all findings by which section they enhance:
```
Section: Technical Approach
- Finding 1 (from skills: dhh-rails-style, security-patterns)
- Finding 2 (from research: Context7, web search)
- Finding 3 (from learning: redis-cache-stampede.md)

Section: Implementation Phase 2
- Finding 4 (from skill: performance-optimization)
- Finding 5 (from research: Task Explore)
...
```

---

## Phase 6: Enhance Plan Sections

Merge research findings back into the plan, adding depth without changing the original structure.

### Enhancement Format for Each Section

```markdown
## [Original Section Title]

[Original content preserved - DO NOT MODIFY]

### Research Insights

**Best Practices:**
- [Concrete recommendation 1] (Source: [agent/skill])
- [Concrete recommendation 2] (Source: [agent/skill])

**Performance Considerations:**
- [Optimization opportunity with expected impact]
- [Benchmark or metric to target]

**Security Considerations:**
- [Security pattern to follow]
- [Vulnerability to avoid]

**Implementation Details:**
```[language]
// Concrete code example from research
// Include file path where this would go
```

**Edge Cases:**
- [Edge case 1]: [How to handle]
- [Edge case 2]: [How to handle]

**Anti-Patterns to Avoid:**
- [Anti-pattern]: [Why it's problematic]

**From Documented Learnings:**
- [Learning title]: [Key insight that applies]

**References:**
- [Documentation URL 1]
- [Documentation URL 2]
```

### Preserve Original Content

**CRITICAL:** Never modify the original plan content. Only ADD the "Research Insights" subsection after each section. The original author's intent must be preserved.

### Code Examples Must Be Concrete

Every code example should:
- Be syntactically correct for the target language
- Include comments explaining the pattern
- Reference specific file paths where it applies
- Be copy-paste ready for implementation

---

## Phase 7: Add Enhancement Summary

At the TOP of the plan, add a comprehensive summary section:

```markdown
## Enhancement Summary

**Deepened on:** [Date]
**Plan file:** [path]
**Sections enhanced:** [Count]

### Research Coverage
- **Skills applied:** [Count] ([list])
- **Learnings checked:** [Count] relevant of [Total] found
- **Research agents:** [Count]
- **Context7 queries:** [Count]
- **Web searches:** [Count]

### Key Improvements
1. [Major improvement 1 - brief description]
2. [Major improvement 2 - brief description]
3. [Major improvement 3 - brief description]

### New Considerations Discovered
- [Important finding 1 that wasn't in original plan]
- [Important finding 2 that wasn't in original plan]

### Conflicts Requiring Resolution
- **[Topic]:** [Brief description of conflict]
  - Side A ([agents]): [Position]
  - Side B ([agents]): [Position]

### Applied Learnings
- [Learning 1]: Applied to [section]
- [Learning 2]: Applied to [section]

---
```

---

## Phase 8: Post-Enhancement Options

### Write Enhanced Plan to Disk

**CRITICAL:** Write the enhanced plan to disk BEFORE presenting options to user.

```bash
# Write to original file (preserving backup)
cp [plan_path] [plan_path].backup
# Write enhanced content
```

### Present Options to User

After writing the enhanced plan, present these options:

**Question:** "Plan deepened at `[plan_path]`. What would you like to do next?"

**Options:**
1. **View diff** - Show what was added/changed
2. **Run plan review** - Get feedback from reviewers on enhanced plan
3. **Start work** - Begin implementing this enhanced plan
4. **Deepen further** - Run another round of research on specific sections
5. **Revert** - Restore original plan from backup

### Handle Selection

Based on selection:

- **View diff** -> Run `git diff [plan_path]` or compare with backup
- **Run plan review** -> Invoke reviewing skill with enhanced plan
- **Start work** -> Invoke executing-work skill with enhanced plan
- **Deepen further** -> Ask which sections need more research, then re-run those agents
- **Revert** -> Restore from `.backup` file

---

## Error Handling

### Agent Failures

- Log failure with agent name and error
- Continue with remaining agents
- Report failures in Enhancement Summary
- Minimum 30% agent success to produce useful output

### Skill Discovery Failures

- If no skills found, proceed with learnings and research agents
- Log which skill sources were checked
- Skill enhancement is valuable but not required

### Learnings Discovery Failures

- If docs/solutions/ doesn't exist, skip learnings phase
- Log that no learnings were found
- Proceed with skills and research agents

### Context7 Failures

- If library ID resolution fails, skip that library
- Fall back to web search for documentation
- Log which libraries couldn't be resolved

### Plan File Issues

- If plan file doesn't exist, ask user for correct path
- If plan file is malformed, report specific parsing errors
- If plan file is empty, ask user to provide content or different file

### Write Failures

- If can't write enhanced plan, display content to user
- Suggest alternative save locations
- Never lose enhancement work due to write failure

---

## Anti-Patterns

### Don't Limit Sub-Agents
- **Wrong:** "Only spawn 5 skill sub-agents to save resources"
- **Right:** Spawn one for EVERY matched skill - 20, 30, 40 is fine

### Don't Filter Prematurely
- **Wrong:** Skip skills that "probably don't apply"
- **Right:** Let each sub-agent determine relevance

### Don't Modify Original Content
- **Wrong:** Rewrite the original plan sections
- **Right:** Add "Research Insights" subsections, preserve original

### Don't Skip Sources
- **Wrong:** Only check project-local skills
- **Right:** Check ALL 5 skill sources

### Don't Serialize Research
- **Wrong:** Run skill agents, then learnings, then research
- **Right:** Launch ALL agents in parallel

### Don't Ignore Conflicts
- **Wrong:** Pick one recommendation and ignore the other
- **Right:** Mark conflicts clearly for user resolution

### Don't Skip Learnings
- **Wrong:** "No time for learnings, just use skills"
- **Right:** Learnings are institutional knowledge - always check

### Don't Provide Vague Enhancements
- **Wrong:** "Consider performance implications"
- **Right:** Concrete code examples with file paths and metrics

---

## Auto-Triggers

This skill activates on:
- "deepen plan"
- "enhance plan"
- "research plan"
- "add research to plan"
- "enrich plan"
- "deep dive on plan"
- "improve plan with research"

---

## Example Enhancement

### Before (from planning skill):
```markdown
## Technical Approach

Use React Query for data fetching with optimistic updates.
```

### After (from plan-deepening skill):
```markdown
## Technical Approach

Use React Query for data fetching with optimistic updates.

### Research Insights

**Best Practices:**
- Configure `staleTime` and `cacheTime` based on data freshness requirements (Source: Context7)
- Use `queryKey` factories for consistent cache invalidation (Source: TkDodo blog)
- Implement error boundaries around query-dependent components (Source: React docs)

**Performance Considerations:**
- Enable `refetchOnWindowFocus: false` for stable data to reduce unnecessary requests
- Use `select` option to transform and memoize data at query level
- Consider `placeholderData` for instant perceived loading
- Target: < 100ms for cached data, < 500ms for fresh fetches

**Security Considerations:**
- Sanitize user input in query keys to prevent cache poisoning
- Never cache sensitive data without encryption consideration

**Implementation Details:**
```typescript
// src/lib/queryClient.ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

// src/hooks/useOptimisticUpdate.ts
const mutation = useMutation({
  mutationFn: updateTodo,
  onMutate: async (newTodo) => {
    await queryClient.cancelQueries({ queryKey: ['todos'] });
    const previous = queryClient.getQueryData(['todos']);
    queryClient.setQueryData(['todos'], (old) => [...old, newTodo]);
    return { previous };
  },
  onError: (err, newTodo, context) => {
    queryClient.setQueryData(['todos'], context.previous);
  },
});
```

**Edge Cases:**
- Handle race conditions with `cancelQueries` on component unmount
- Implement retry logic for transient network failures
- Consider offline support with `persistQueryClient`
- Handle stale-while-revalidate for slow network conditions

**Anti-Patterns to Avoid:**
- Don't use `refetchOnMount: 'always'` for expensive queries
- Don't forget to handle loading and error states
- Don't put sensitive data in query keys (they're logged)

**From Documented Learnings:**
- `redis-cache-stampede.md`: Apply similar debouncing pattern for concurrent cache misses

**References:**
- https://tanstack.com/query/latest/docs/react/guides/optimistic-updates
- https://tkdodo.eu/blog/practical-react-query
- https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
```

---

## Quality Checks

Before finalizing:
- [ ] All original content preserved unchanged
- [ ] Research insights clearly marked and attributed
- [ ] Code examples are syntactically correct
- [ ] Links are valid and relevant
- [ ] No contradictions between sections (or marked as conflicts)
- [ ] Enhancement summary accurately reflects changes
- [ ] All discovered skills were spawned as sub-agents
- [ ] Learnings were checked and relevant ones applied
- [ ] Plan file written to disk before presenting options

---

## Key Principles Summary

1. **MAXIMUM COVERAGE** - Run every skill, every relevant learning, every research agent
2. **PARALLEL EXECUTION** - Never serialize what can be parallelized
3. **PRESERVE ORIGINAL** - Add enhancements, don't modify original content
4. **CONCRETE EXAMPLES** - Code snippets with file paths, not vague advice
5. **CHECK ALL 5 SOURCES** - Project, user, plugin skills + learnings + research
6. **NO SUB-AGENT LIMITS** - 20, 30, 40 skill sub-agents is fine
7. **DEDUPLICATE INTELLIGENTLY** - Merge similar, flag conflicts, prioritize by impact
8. **WRITE BEFORE OPTIONS** - Save enhanced plan to disk before asking user what's next
9. **INSTITUTIONAL KNOWLEDGE** - Learnings prevent repeating past mistakes
