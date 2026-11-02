---
description: Use when implementing or reviewing Flywheel TypeScript with Bun APIs and strict types.
---

# TypeScript and Bun

Input: a bounded Flywheel TypeScript change and its module and runtime boundary.

Prefer existing project code, standard runtime features, Bun APIs, and installed dependencies before custom code. Model variants with strict types and discriminated unions. A tool input schema root is always one `type: "object"` schema with a discriminating enum field for variants, never a `oneOf`, `anyOf`, or `allOf` union, because providers reject a union root. Normalize external variation at the boundary and keep owned state strict. Place code in the owning module and preserve dependency direction. Extract only cohesive reused or independently responsible units. Inject side effects, register new behavior through the owning registry, remove dead exports and forwarding wrappers, and preserve platform process requirements.

Stop when all call sites and registry consumers are wired and assigned verification passes. Return implementation or review decisions, affected files and registrations, type and runtime proof, and compatibility risk. Report unavailable runtime capability, boundary conflict, or impossible platform contract. Never bypass it with `any`, a barrel, compatibility shim, or raw process launch.