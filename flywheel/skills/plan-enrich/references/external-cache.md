# External Research Cache

Cache external research results (Context7, web searches) to avoid redundant API calls across sessions.

## Cache Location

`.flywheel/cache/external/` (gitignored via `.flywheel/`)

## Cache Format

Each cached result is a markdown file with YAML frontmatter:

```markdown
---
library: react-query
query: "offline persistence support"
source: context7
fetched: 2024-01-15
---

# Context7: React Query - Offline Persistence

[cached response content here]
```

### Filename Convention

`<library-slug>-<query-slug>.md`

Examples:
- `react-query-offline-persistence.md`
- `nextjs-server-actions-stability.md`

## Cache Check (Before External Calls)

Before calling Context7 or web-searcher/web-analyzer, check for recent cached results:

```bash
# Check for cached results less than 7 days old
find .flywheel/cache/external/ -name "<library-slug>*.md" -mtime -7 2>/dev/null
```

### Logic

```
IF cached file found (< 7 days old):
  Read cached file instead of calling Context7/web
  Log: "Using cached research for [library] (cached [N] days ago)"

IF no cache found OR cache > 7 days old:
  Call Context7/web as normal
  Write response to .flywheel/cache/external/<library-slug>-<query-slug>.md
  Log: "Cached research for [library] to .flywheel/cache/external/"
```

### TTL

Uses `find -mtime -7` for a 7-day TTL. No timestamp parsing needed — filesystem mtime handles expiry.

## Writing Cache

After a successful external research call, write the result:

```bash
mkdir -p .flywheel/cache/external
```

Write file with YAML frontmatter (`library`, `query`, `source`, `fetched`) followed by the response content.
