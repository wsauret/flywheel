---
description: Use when inventorying a product's reachable user-visible surface from code.
---

# Surface Mapping

Start with a repository root and product scope. Determine project shape from manifests and wired entry points. Enumerate applicable user-visible categories and locate defining registries, schemas, routes, handlers, components, public configuration readers, persistence outputs, output types, lifecycle states, and failure states. Verify each candidate is production-reachable and externally observable. Emit one row per distinct behavior, connect prerequisites and external dependencies, compare documentation only as background, record drift, and run a category completeness pass.

Each row contains stable ID, category, name, defining `path:line`, observable expected behavior, dependencies, and variants. Stop when every applicable public registry is exhausted or recorded as an explicit gap. Return project shape, flat rows, inspected files, and open gaps. A sparse project returns an empty map with evidence. An unenumerable category is a gap, never a sample. Exclude private mechanisms with no observable consequence and do not create QA artifacts.