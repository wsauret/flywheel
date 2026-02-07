# Results Presentation Template

Use this template to present consolidation results to the user.

## Summary Output

```
Plan Consolidated

Plan: [plan_path]
Context: [context_path]

Summary:
- Phases: [count]
- Checklist items: [count]
- Research insights integrated: [count]
- Review findings addressed: [count]

Status:
- P1 findings: [count] ([status])
- Ready for: [/fly:work OR "Blocked - see Critical Items"]
```

## Post-Consolidation Options

After presenting results, ask the user what to do next:

**AskUserQuestion:** "Plan consolidated and ready. What next?"

| Option | Action |
|--------|--------|
| Start /fly:work (Recommended) | Invoke `skill: work-implementation` |
| Done for now | Display path and exit |
