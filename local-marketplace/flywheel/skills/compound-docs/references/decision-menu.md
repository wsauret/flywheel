# Decision Menu Reference

After successful documentation, present options and WAIT for user response.

## Menu Display

```
✓ Solution documented

File created:
- docs/solutions/[category]/[filename].md

What's next?
1. Continue workflow (recommended)
2. Add to Required Reading - Promote to critical patterns
3. Link related issues - Connect to similar problems
4. Add to existing skill - Add to a learning skill
5. Create new skill - Extract into new learning skill
6. View documentation - See what was captured
7. Other
```

---

## Option Handling

### Option 1: Continue workflow
- Return to calling skill/workflow
- Documentation is complete

### Option 2: Add to Required Reading

User selects when:
- System made this mistake multiple times across modules
- Solution is non-obvious but must be followed every time
- Foundational requirement (API design, database access, threading)

**Action:**
1. Extract pattern from documentation
2. Format as ❌ WRONG vs ✅ CORRECT with code examples
3. Add to `docs/solutions/patterns/critical-patterns.md`
4. Add cross-reference back to this doc
5. Confirm: "✓ Added to Required Reading"

### Option 3: Link related issues
- Prompt: "Which doc to link?"
- Search docs/solutions/ for the doc
- Add cross-reference to both docs
- Confirm: "✓ Cross-reference added"

### Option 4: Add to existing skill

**Action:**
1. Prompt: "Which skill? (compound-docs, git-worktree, etc.)"
2. Determine reference file (resources.md, patterns.md, or examples.md)
3. Add link and brief description
4. Confirm: "✓ Added to [skill-name] in [file]"

### Option 5: Create new skill

**Action:**
1. Prompt: "What should the new skill be called?"
2. Create skill directory: `mkdir -p plugin/skills/[skill-name]`
3. Create `SKILL.md` with skill template
4. Create initial reference files with this solution
5. Confirm: "✓ Created new [skill-name] skill"

### Option 6: View documentation
- Display the created documentation
- Present decision menu again

### Option 7: Other
- Ask what they'd like to do

---

## Critical Pattern Detection

If this issue has automatic indicators suggesting it might be critical:
- Severity: `critical` in YAML
- Affects multiple modules OR foundational stage
- Non-obvious solution

Then add a note in the decision menu:
```
💡 This might be worth adding to Required Reading (Option 2)
```

But **NEVER auto-promote**. User decides via Option 2.

---

## Critical Pattern Template

When user selects Option 2 (Add to Required Reading):

```markdown
## Pattern [N]: [Pattern Name]

**Problem:** [Brief description of what goes wrong]

**Why it happens:** [Root cause explanation]

❌ **WRONG:**
```[language]
// Code that causes the problem
```

✅ **CORRECT:**
```[language]
// Code that solves the problem
```

**Example:** See [link to solution doc]

**Detection:** [How to notice this is happening]

**Prevention:** [How to avoid in future code]
```

Number sequentially based on existing patterns in `docs/solutions/patterns/critical-patterns.md`.
