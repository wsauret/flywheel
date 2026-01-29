---
name: fly:consolidate
description: Consolidate a deepened and reviewed plan into work-ready format. Standalone command for the plan-consolidation skill.
argument-hint: "[path to plan file]"
---

# Consolidate Plan

<input> #$ARGUMENTS </input>

This command consolidates a plan that has been deepened and reviewed into a single, actionable document ready for `/fly:work`.

**Note: The current year is 2026.**

## Prerequisites

The plan should have already been:
1. **Deepened** (with "Enhancement Summary" and "Research Insights" subsections)
2. **Reviewed** (with "Plan Review Summary" section)

If sections are missing, the skill will warn but can proceed anyway.

## Invoke the Skill

```
skill: plan-consolidation
arguments: [plan path from input]
```

## What This Does

The plan-consolidation skill will:

1. **Analyze** the current plan structure
2. **Extract** all research insights, review findings, and implementation steps
3. **Synthesize** into a unified document with:
   - Executive Summary
   - Critical Items (P1 findings, conflicts)
   - Implementation Checklist with integrated insights
   - Technical Reference section
   - Review Findings Summary
   - Appendix with raw data
4. **Write** the consolidated plan back to the same file
5. **Update** the context file with consolidation metadata

## When to Use

- After running `/fly:plan` phases separately
- When you've manually added research or reviews to a plan
- To re-consolidate a plan after addressing P1 findings
- Before starting `/fly:work` to ensure the plan is actionable

## Example

```bash
/fly:consolidate plans/feat-user-auth.md
```

Transforms the plan from scattered content (deepening + review sections) into a clean, work-ready checklist format.
