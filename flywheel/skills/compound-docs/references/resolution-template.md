# Resolution Template

Template for solution documentation files.

## File Structure

```markdown
---
module: [Module name]
date: [YYYY-MM-DD]
problem_type: [enum from yaml-schema.md]
component: [enum from yaml-schema.md]
symptoms:
  - "[Symptom 1]"
  - "[Symptom 2]"
root_cause: [enum from yaml-schema.md]
resolution_type: [enum from yaml-schema.md]
severity: [critical|high|medium|low]
framework_version: [X.Y.Z if applicable]
tags: [keyword1, keyword2]
---

# [Descriptive Title]

## Symptom

[What was observed - exact error messages, observable behavior]

## Investigation

### Attempted (Failed)
1. [What was tried first and why it didn't work]
2. [Another failed attempt]

### Discovery
[How the actual root cause was found]

## Root Cause

[Technical explanation of why the problem occurred]

## Solution

### Code Changes

```[language]
// [file_path:line_number]
[The actual fix]
```

### Configuration Changes (if applicable)

```[format]
[Configuration that was changed]
```

## Prevention

[How to avoid this problem in the future]

- [Checklist item 1]
- [Checklist item 2]

## Related Issues

- [Link to related solution if any]
- [GitHub issue if applicable]

## Environment

- **Framework version:** [X.Y.Z]
- **Environment:** [development|staging|production]
- **OS:** [if relevant]
```

---

## Filename Generation

**Format:** `[sanitized-symptom]-[module]-[YYYYMMDD].md`

**Sanitization rules:**
- Lowercase
- Replace spaces with hyphens
- Remove special characters except hyphens
- Truncate to < 80 chars

**Examples:**
- `missing-include-BriefSystem-20251110.md`
- `parameter-not-saving-state-EmailProcessing-20251110.md`
- `webview-crash-on-resize-Assistant-20251110.md`

---

## Quality Checklist

Good documentation has:
- ✅ Exact error messages (copy-paste from output)
- ✅ Specific file:line references
- ✅ Observable symptoms (what you saw, not interpretations)
- ✅ Failed attempts documented (helps avoid wrong paths)
- ✅ Technical explanation (not just "what" but "why")
- ✅ Code examples (before/after if applicable)
- ✅ Prevention guidance (how to catch early)
- ✅ Cross-references (related issues)

Avoid:
- ❌ Vague descriptions ("something was wrong")
- ❌ Missing technical details ("fixed the code")
- ❌ No context (which version? which file?)
- ❌ Just code dumps (explain why it works)
