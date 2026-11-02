---
description: "Use when planning or reviewing a rendered user-facing surface: layout, theming, states, motion, or copy."
---

# Interface Design

Plan and review user-facing surfaces that read as part of their host and spend the user's attention deliberately. This method applies when writing an interface plan, reviewing an interface plan, or reviewing implemented interface code. It does not implement frontend code. Correctness, accessibility, and the host platform's conventions are hard gates.

## Input

Start with the requested surface change, the host it renders in, and the host's existing visual system: shared tokens, type scale, spacing rhythm, theme structure, and interaction conventions. Extend that system rather than introducing a parallel one, and report any deliberate deviation.

## Principles

- Establish hierarchy before decoration. A reader must find the primary action and the primary information without scanning twice. Type scale, weight, and spacing carry hierarchy; color and ornament come last.
- Spend emphasis (color, motion, size, weight) only where the user's attention must go, and spend it in one place rather than everywhere.
- Keep one source of truth for shared visual values. Repeated or theme-dependent sizes, colors, radii, and durations live as tokens the components read. Keep a genuinely component-local decision local when it does not duplicate an existing token.
- Design every theme the host offers as a set. A color defined for one theme and inherited in another is a defect, not a default. Verify contrast on every theme's ground.
- Fit the host surface. An embedded panel reads as part of its editor, terminal, or window: its spacing rhythm, focus treatment, and typography. A surface that looks pasted in from another product is a defect even when it is attractive.
- Give every interactive element its states: hover, focus-visible, active, disabled, and busy. Design empty, loading, and error as first-class states, not as absences.
- Let layout own spacing. Sibling gaps come from the container, not from per-element margins that collapse or double. Wide content scrolls inside its own region; the page never scrolls sideways.
- Restrain motion. Animation explains a state change or directs attention; it never runs for its own sake, and reduced-motion preferences are respected.
- Treat copy as design material. Controls say exactly what happens, labels name what users recognize, and errors say what went wrong and what fixes it.

Name recognized defects when useful: Theme Leak, Spacing Drift, Fake Affordance, Dead State, Foreign Object, Contrast Debt, Decoration Without Information, Motion Noise, Literal Value, Unstyled State.

## Planning mode

When writing a design or implementation spec, make the intended hierarchy, primary action, host-system reuse, interaction states, themes, overflow behavior, motion, and copy explicit wherever they affect the requested surface. Record how the implemented surface will be checked with realistic data, including long titles, empty lists, many items, and every supported theme. Do not claim that an appearance was observed before a render exists.

Do not write frontend code. Return through the active planning method's result contract.

## Review mode

Apply the principles above through exactly one active review target. For plan review, judge whether the spec carries the necessary interface decisions and qualitative verification without demanding a pre-implementation render. For code review, judge the rendered result with realistic data and treat an unobserved appearance claim as missing evidence. Return through the active target's locations, severity, and result contract. Do not select reviewers, route workflow work, or combine findings.
