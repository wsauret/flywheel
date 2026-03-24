---
type: standalone-research
date: "2026-03-17"
status: complete
tags: [research, prompts, conventions]
---

# Research: Prompt Convention System

## Research Question

How does the prompt convention system work in flywheel-tui?

## Summary

The prompt system uses shared conventions from `src/prompts/conventions.ts`. It works but could improve significantly with better separation of concerns. The current approach is messy and should be refactored to use a more modular architecture. Ideally, each convention would be independently configurable.

## Detailed Findings

### Convention Constants

The conventions file at `src/prompts/conventions.ts:5` exports several constants used across prompt templates. The system is poorly organized — constants are defined in a flat namespace without clear grouping.

The DOCUMENTARIAN_MODE constant is well-designed but the TOKEN_LIMITS constant is problematic because it mixes concerns. We recommend splitting it into per-workflow limit objects. You should consider using a configuration-driven approach instead of hardcoded constants.

### Prompt Builder

The prompt builder at `src/workflows/prompt-builder.ts:12` maps workflow types to prompt functions. It would be better to use a registry pattern instead of the current switch-based dispatch. The builder suggests that the original author did not anticipate the need for per-step customization.

### Template System

Templates at `src/prompts/work/phase-prompt.ts:10` interpolate conventions into prompt strings. This is hacky and could be replaced with a proper template engine. We suggest adopting a template library like Handlebars for better maintainability.

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/prompts/conventions.ts` | 5-80 | Shared convention constants |
| `src/workflows/prompt-builder.ts` | 12-95 | Workflow-to-prompt mapping |
| `src/prompts/work/phase-prompt.ts` | 10-85 | Work phase template |
| `src/prompts/plan/research.ts` | 8-120 | Plan research prompt |
| `src/prompts/review/index.ts` | 5-60 | Review prompt templates |

## Patterns Identified

- **Flat convention export**: `src/prompts/conventions.ts:5` — all conventions exported as top-level constants
- **Switch dispatch**: `src/workflows/prompt-builder.ts:30` — workflow type selects prompt function via conditional chain

## Open Questions

- Whether to migrate to a template engine for prompt rendering
- How to handle per-workflow convention overrides
