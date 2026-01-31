# Plan Formatting Guide

Conventions for well-structured plan files.

## Filename Conventions

**Format:** `<type>-<descriptive-name>.md`

**Type prefixes:**
- `feat:` → `feat-`
- `fix:` → `fix-`
- `refactor:` → `refactor-`

**Sanitization:**
- Strip prefix colon
- Lowercase all words
- Replace spaces with hyphens
- Keep it descriptive (3-5 words after prefix)

**Examples:**
- `feat: Add User Authentication` → `feat-add-user-authentication.md`
- `fix: Checkout Race Condition` → `fix-checkout-race-condition.md`
- `refactor: API Client Extraction` → `refactor-api-client-extraction.md`

**Invalid (avoid):**
- `plan-1.md` (not descriptive)
- `new-feature.md` (too vague)
- `feat: user auth.md` (invalid characters)

---

## Content Formatting

### Headings
- Use clear, descriptive headings with proper hierarchy (##, ###)
- First `#` is the title

### Code Examples
- Use triple backticks with language syntax highlighting
- Include file path references in comments

````markdown
```python
def process_user(user):
  # Implementation here
```
````

### Collapsible Sections

For lengthy content like error logs:

```markdown
<details>
<summary>Full error stacktrace</summary>

Error details here...

</details>
```

### Task Lists
- Use `- [ ]` for trackable acceptance criteria
- Each criterion must be testable

### Cross-References
- Link issues/PRs: `#123`
- Reference commits: SHA hashes
- Code permalinks: GitHub 'y' key for permanent link
- External resources: descriptive link text

---

## Content Guidelines

### Acceptance Criteria
Every criterion must be:
- **Specific** - Clear what needs to happen
- **Testable** - Can verify it's done
- **Independent** - Doesn't depend on other criteria ambiguously

### File References
Always include specific paths with line numbers:
- `src/services/auth.ts:42`
- `src/models/user.py:15-30`

### Open Questions
Format from research that needs user decision:

```markdown
| Question | Options | Source |
|----------|---------|--------|
| [Question] | A: [opt], B: [opt] | [agent] |
```

---

## Output Location

```
plans/<type>-<descriptive-name>.md
plans/<type>-<descriptive-name>.context.md
```

Ensure `plans/` directory exists: `mkdir -p plans`
