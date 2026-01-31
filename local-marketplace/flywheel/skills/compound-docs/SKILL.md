---
name: compound-docs
description: Document solved problems to compound team knowledge. Creates categorized docs with YAML frontmatter. Triggers on "that worked", "it's fixed", "compound".
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Task
  - AskUserQuestion
---

# Compound-Docs Skill

Document solved problems to build searchable institutional knowledge.

**Why "compound"?** Each documented solution compounds your team's knowledge. First time solving a problem takes research. Document it, and the next occurrence takes minutes.

**Preconditions:**
- Problem has been solved (not in-progress)
- Solution has been verified working

**Organization:** Single-file per problem in category directory (e.g., `docs/solutions/performance-issues/n-plus-one-query.md`).

---

## Step 1: Detect Confirmation

**Auto-invoke after:** "that worked", "it's fixed", "working now", "problem solved"

**OR manual:** `/fly:compound` command

**Non-trivial problems only:**
- Multiple investigation attempts needed
- Tricky debugging
- Non-obvious solution

**Skip:** Simple typos, obvious syntax errors, trivial fixes.

---

## Step 2: Gather Context

Extract from conversation history:

- **Module** - Which component had the problem
- **Symptom** - Exact error messages, observable behavior
- **Investigation** - What was tried, what didn't work
- **Root cause** - Technical explanation
- **Solution** - Code/config changes that fixed it
- **Prevention** - How to avoid in future

**If critical context missing**, ask user:

```
I need a few details to document this:
1. Which module/component?
2. What was the exact error?
3. What environment?
```

---

## Step 3: Check Existing Docs

```bash
grep -r "exact error phrase" docs/solutions/
```

**If similar found:** Ask whether to create new doc with cross-reference or update existing.

**If none:** Proceed.

---

## Step 4: Validate YAML & Create File

Validate against `references/yaml-schema.md`:
- All required fields present
- Enum values match exactly
- symptoms is array (1-5 items)

Determine category from problem_type, create file:

```bash
mkdir -p "docs/solutions/${CATEGORY}"
```

Write using template from `references/resolution-template.md`.

---

## Step 5: Optional Specialized Review

For complex issues, invoke relevant reviewer:

| Problem Type | Reviewer |
|-------------|----------|
| performance_issue | performance-analyst |
| security_issue | security-reviewer |
| database_issue | data-integrity-guardian |

**Only if** the problem was particularly tricky or affects critical systems.

---

## Step 6: Present Results

Per `references/decision-menu.md`:

```
✓ Solution documented

File: docs/solutions/[category]/[filename].md

What's next?
1. Continue workflow (recommended)
2. Add to Required Reading
3. Link related issues
4. View documentation
5. Other
```

---

## Error Handling

- **Missing context:** Ask user, wait
- **YAML validation failure:** Show errors, block until valid
- **Similar issue found:** Present options

---

## Anti-Patterns

- Document trivial fixes
- Document without verified solution
- Vague docs without code examples
- Skip cross-references

---

## Detailed References

- `references/yaml-schema.md` - YAML fields, enums, category mapping
- `references/resolution-template.md` - File template, filename rules
- `references/decision-menu.md` - Post-documentation options
