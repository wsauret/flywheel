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

**Why "compound"?** Each documented solution compounds your team's knowledge like compound interest. First time solving a problem takes research. Document it, and the next occurrence takes minutes.

**Compounding vs Compaction:** Flywheel uses two strategies (see README):
- **Compaction** = Reduce context mid-work (`.context.md`, `.state.md` files)
- **Compounding** = Accumulate knowledge post-work (this skill)

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

**Additional categories:**
- `pattern` = Successful approach worth reusing → `docs/solutions/patterns/`
- `mistake` = Failed approach with prevention guidance → `docs/solutions/mistakes/`

---

## Step 1.5: 3-Strike Integration

**When invoked after 3-Strike escalation** (error resolved with user help), capture:

- **What failed**: All 3 attempts (sanitized - remove credentials, API keys, PII, internal URLs)
- **Why it failed**: Root cause analysis
- **What worked**: User-provided solution
- **How to prevent**: Future guidance

This creates institutional memory from hard-won debugging sessions.

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

## Step 4: Sanitize & Validate

**Before documenting, sanitize sensitive data:**
- Remove credentials, API keys, secrets
- Remove PII (names, emails, IDs)
- Replace internal URLs with `[internal-url]`
- Generalize environment-specific paths

Then validate against `references/yaml-schema.md`:
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
| performance_issue | performance-reviewer |
| security_issue | security-reviewer |
| database_issue | data-integrity-reviewer |

**Only if** the problem was particularly tricky or affects critical systems.

---

## Step 5.5: Standards Inference

After documenting the solution, check if this pattern generalizes:

```bash
# Search for solutions with similar tags or problem types
grep -rl "<root-cause-keyword>" docs/solutions/ | head -5
```

If 2+ solutions share the same root cause type or pattern (e.g., same type of fix in the same component area), suggest creating a standard:

**AskUserQuestion:** "This pattern appears in [N] solutions ([list filenames]). Capture as a reusable standard?"
- **Yes** — Draft standard from the shared pattern, write to `docs/standards/<pattern-name>.md` per the format in `docs/standards/README.md`, user confirms content
- **Skip (Recommended)** — Continue without creating a standard

Only suggest when the pattern is clearly reusable, not when solutions happen to touch the same file.

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
