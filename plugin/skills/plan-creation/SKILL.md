---
name: plan-creation
description: Research codebase and create implementation plans. Use alone for quick plans, or as part of full /fly:plan flow. Triggers on "create plan", "plan for", "write a plan".
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - Task
  - Skill
  - AskUserQuestion
---

# Plan Creation Skill

Transform feature descriptions, bug reports, or improvement ideas into well-structured markdown plan files. This skill can run standalone for quick plans or be orchestrated by `/fly:plan` for the full workflow (research + deepen + review).

**Note: The current year is 2026.** Use this when dating plans and searching for recent documentation.

## Input

The feature description is provided via `$ARGUMENTS`.

**If empty:** Ask the user: "What would you like to plan? Please describe the feature, bug fix, or improvement you have in mind."

Do not proceed until you have a clear feature description.

---

## Phase 1: Research & Context Gathering (Parallel Agents)

Launch three research agents simultaneously to understand the project landscape.

### Run ALL Agents in Parallel

```
Task repo-research-analyst: "Analyze codebase for patterns related to: <feature_description>.
Find: existing implementations, file structure, naming conventions, relevant services.
Return: file paths with line numbers (e.g., src/services/auth.ts:42)"

Task best-practices-researcher: "Research best practices for: <feature_description>.
Find: industry standards, common patterns, anti-patterns to avoid.
Use WebSearch for current (2026) best practices if applicable."

Task framework-docs-researcher: "Research framework documentation for: <feature_description>.
Use mcp__plugin_Flywheel_context7__resolve-library-id to find library IDs.
Use mcp__plugin_Flywheel_context7__query-docs to query specific documentation.
Return: relevant code examples, configuration patterns, version-specific guidance."
```

### Framework Documentation Lookup

For detected frameworks/libraries, query Context7:

```
# Step 1: Resolve library ID
mcp__plugin_Flywheel_context7__resolve-library-id
  query: "<what you need to accomplish>"
  libraryName: "<framework name>"

# Step 2: Query documentation
mcp__plugin_Flywheel_context7__query-docs
  libraryId: "<resolved library ID>"
  query: "<specific question or feature>"
```

### Reference Collection

After agents complete, consolidate:
- [ ] Document findings with specific file paths (e.g., `app/services/example_service.rb:42`)
- [ ] Include URLs to external documentation and best practices guides
- [ ] Create reference list of similar issues or PRs (e.g., `#123`, `#456`)
- [ ] Note team conventions discovered in `CLAUDE.md` or team documentation

---

## Phase 2: Issue Planning & Structure

### Title & Categorization

**Draft clear, searchable issue title** using conventional format:
- `feat: Add user authentication`
- `fix: Cart total calculation`
- `refactor: Extract API client`

**Convert title to kebab-case filename:**
- Strip prefix colon
- Lowercase all words
- Replace spaces with hyphens
- Keep it descriptive (3-5 words after prefix) so plans are findable by context

**Examples:**
- `feat: Add User Authentication` -> `feat-add-user-authentication.md`
- `fix: Checkout Race Condition` -> `fix-checkout-race-condition.md`
- `refactor: API Client Extraction` -> `refactor-api-client-extraction.md`

**Invalid filenames (avoid):**
- `plan-1.md` (not descriptive)
- `new-feature.md` (too vague)
- `feat: user auth.md` (invalid characters)

### Stakeholder Analysis

- [ ] Identify who will be affected (end users, developers, operations)
- [ ] Consider implementation complexity and required expertise
- [ ] Determine appropriate detail level based on complexity

---

## Phase 3: Acceptance Criteria Analysis (Optional)

For features with complex user interactions, manually analyze for Gherkin-style scenarios:

**Consider these aspects:**
- User journeys and flows
- Edge cases and error states
- Acceptance criteria gaps

**Incorporate analysis:**
- [ ] Identify key user scenarios
- [ ] Add identified gaps or edge cases to the plan
- [ ] Update acceptance criteria based on findings

---

## Phase 4: Choose Detail Level

Select how comprehensive the plan should be. Simpler is mostly better.

### MINIMAL (Quick Issue)

**Best for:** Simple bugs, small improvements, clear features

**Includes:**
- Problem statement or feature description
- Basic acceptance criteria
- Essential context only

**Template:**

````markdown
[Brief problem/feature description]

## Acceptance Criteria

- [ ] Core requirement 1
- [ ] Core requirement 2

## Context

[Any critical information]

## MVP

### test.rb

```ruby
class Test
  def initialize
    @name = "test"
  end
end
```

## References

- Related issue: #[issue_number]
- Documentation: [relevant_docs_url]
````

---

### MORE (Standard Issue)

**Best for:** Most features, complex bugs, team collaboration

**Includes everything from MINIMAL plus:**
- Detailed background and motivation
- Technical considerations
- Success metrics
- Dependencies and risks
- Basic implementation suggestions

**Template:**

```markdown
## Overview

[Comprehensive description]

## Problem Statement / Motivation

[Why this matters]

## Proposed Solution

[High-level approach]

## Technical Considerations

- Architecture impacts
- Performance implications
- Security considerations

## Acceptance Criteria

- [ ] Detailed requirement 1
- [ ] Detailed requirement 2
- [ ] Testing requirements

## Success Metrics

[How we measure success]

## Dependencies & Risks

[What could block or complicate this]

## References & Research

- Similar implementations: [file_path:line_number]
- Best practices: [documentation_url]
- Related PRs: #[pr_number]
```

---

### A LOT (Comprehensive Issue)

**Best for:** Major features, architectural changes, complex integrations

**Includes everything from MORE plus:**
- Detailed implementation plan with phases
- Alternative approaches considered
- Extensive technical specifications
- Resource requirements and timeline
- Future considerations and extensibility
- Risk mitigation strategies
- Documentation requirements

**Template:**

```markdown
## Overview

[Executive summary]

## Problem Statement

[Detailed problem analysis]

## Proposed Solution

[Comprehensive solution design]

## Technical Approach

### Architecture

[Detailed technical design]

### Implementation Phases

#### Phase 1: [Foundation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 2: [Core Implementation]

- Tasks and deliverables
- Success criteria
- Estimated effort

#### Phase 3: [Polish & Optimization]

- Tasks and deliverables
- Success criteria
- Estimated effort

## Alternative Approaches Considered

[Other solutions evaluated and why rejected]

## Acceptance Criteria

### Functional Requirements

- [ ] Detailed functional criteria

### Non-Functional Requirements

- [ ] Performance targets
- [ ] Security requirements
- [ ] Accessibility standards

### Quality Gates

- [ ] Test coverage requirements
- [ ] Documentation completeness
- [ ] Code review approval

## Success Metrics

[Detailed KPIs and measurement methods]

## Dependencies & Prerequisites

[Detailed dependency analysis]

## Risk Analysis & Mitigation

[Comprehensive risk assessment]

## Resource Requirements

[Team, time, infrastructure needs]

## Future Considerations

[Extensibility and long-term vision]

## Documentation Plan

[What docs need updating]

## References & Research

### Internal References

- Architecture decisions: [file_path:line_number]
- Similar features: [file_path:line_number]
- Configuration: [file_path:line_number]

### External References

- Framework documentation: [url]
- Best practices guide: [url]
- Industry standards: [url]

### Related Work

- Previous PRs: #[pr_numbers]
- Related issues: #[issue_numbers]
- Design documents: [links]
```

---

## Phase 5: Write Plan File

### Content Formatting

- [ ] Use clear, descriptive headings with proper hierarchy (##, ###)
- [ ] Include code examples in triple backticks with language syntax highlighting
- [ ] Add screenshots/mockups if UI-related
- [ ] Use task lists (`- [ ]`) for trackable items
- [ ] Add collapsible sections for lengthy logs using `<details>` tags
- [ ] Apply appropriate emoji for visual scanning (bug, feature, docs, refactor)

### Cross-Referencing Conventions

- [ ] Link to related issues/PRs using `#number` format
- [ ] Reference specific commits with SHA hashes when relevant
- [ ] Link to code using GitHub's permalink feature (press 'y' for permanent link)
- [ ] Mention relevant team members with `@username` if needed
- [ ] Add links to external resources with descriptive text

### Code & Examples

````markdown
# Good example with syntax highlighting and line references

```ruby
# app/services/user_service.rb:42
def process_user(user)
  # Implementation here
end
```

# Collapsible error logs

<details>
<summary>Full error stacktrace</summary>

`Error details here...`

</details>
````

### AI-Era Considerations

- [ ] Account for accelerated development with AI pair programming
- [ ] Include prompts or instructions that worked well during research
- [ ] Note which AI tools were used for initial exploration
- [ ] Emphasize comprehensive testing given rapid implementation
- [ ] Document any AI-generated code that needs human review

### Pre-Write Checklist

- [ ] Title is searchable and descriptive
- [ ] All template sections are complete
- [ ] Links and references are working
- [ ] Acceptance criteria are measurable
- [ ] File names in pseudo code examples and todo lists
- [ ] ERD mermaid diagram if applicable for new model changes

### Output Location

```
plans/<type>-<descriptive-name>.md
```

**Examples:**
- `plans/feat-user-authentication-flow.md`
- `plans/fix-checkout-race-condition.md`
- `plans/refactor-api-client-extraction.md`

---

## Phase 6: Create Context File

Persist research findings for downstream reuse (deepening, review, work phases).

**File:** `plans/<plan-name>.context.md`

**Structure:**

```markdown
---
plan: <plan-filename>.md
created: <date>
feature: "<feature description>"
researchers:
  - repo-research-analyst
  - best-practices-researcher
  - framework-docs-researcher
---

# Research Context: <Feature Name>

## File References

<list of specific file paths, one per line>

## Naming Conventions

- [Convention type]: [pattern observed]

## External Research

### Framework Documentation

- [URL with description]

### Best Practices

- [Best practice with source]

## Gotchas & Warnings

- [Warning about patterns or pitfalls]

## Research Quality

- **Confidence**: High/Medium/Low
- **Last verified**: <date>
```

---

## Phase 7: Post-Creation Options

After writing both files, use **AskUserQuestion** to present next steps:

**Question:** "Plan ready at `plans/<plan-name>.md`. What would you like to do next?"

**Options:**

1. **Deepen plan** - Enhance with parallel research agents (skills, learnings, best practices)
2. **Review plan** - Get feedback from reviewer agents (architecture, security, performance)
3. **Start work** - Begin implementing this plan with `/fly:work`
4. **Done for now** - Exit and review plan manually

### Based on Selection

| Selection | Action |
|-----------|--------|
| Deepen plan | Invoke `skill: plan-deepening` with the plan file |
| Review plan | Invoke `skill: reviewing` with the plan file |
| Start work | Invoke `skill: executing-work` with plan path |
| Done for now | Display plan path and exit |

If the user selects **Other** (free text), accept the input for rework or specific changes, then loop back to options.

---

## Error Handling

### Agent Failures

- Log failure with agent name and error
- Continue with remaining agents
- Report failures in output
- Minimum 50% agent success to produce useful output

### Missing Context

- If CLAUDE.md doesn't exist, note conventions may be incomplete
- If similar implementations not found, rely more on best practices research
- If Context7 lookup fails, use WebSearch as fallback

### File Write Failures

- If `plans/` directory doesn't exist, create it with `mkdir -p`
- If file write fails, report error with path and permission details
- Save partial results to temp location rather than losing all work

### Recovery

- Context file tracks research progress
- Re-running with same feature description can skip completed research
- Plan can be regenerated from context file if needed

---

## Anti-Patterns

- **Don't skip research** - Even "simple" features benefit from context gathering
- **Don't over-engineer simple issues** - Use MINIMAL for straightforward tasks
- **Don't write vague acceptance criteria** - Each criterion must be testable
- **Don't forget file references** - Always include specific paths with line numbers
- **Don't ignore team conventions** - Check CLAUDE.md and existing patterns
- **Don't create plans without context files** - Context enables downstream phases
- **Don't start coding** - This skill is research and planning only
- **Don't skip the AskUserQuestion** - User must choose next step

---

## Auto-Triggers

This skill activates on:
- "create plan"
- "plan for"
- "write a plan"
- "planning for"
- "make a plan"
- "draft a plan"
