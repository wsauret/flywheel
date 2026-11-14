{
  "schema_version": 1,
  "summary": "Make a saved page visible at once, as REQUEST.md asks, by dropping the affected cache entries when savePage stores the page: both rendered views of the page, the index of its section, and the index of its old section when the page moved. The cache and its ten-minute lifetime stay.",
  "context": {
    "key_files": [
      "REQUEST.md - The handbook editors' request.",
      "src/editor.ts - savePage validates the title and section and stores the page; it does not touch the cache today.",
      "src/render.ts - renderPage caches each view under `page:<slug>:<view>` (views html and print); renderSectionIndex caches under `section:<section>`.",
      "src/cache.ts - TtlCache. invalidate(prefix) removes every entry whose key starts with the prefix, so one call clears all cached views of a page.",
      "src/pages.ts - PageStore.",
      "tests/render.test.ts, tests/cache.test.ts - Existing coverage."
    ],
    "patterns": [
      "Render functions take { pages, cache } as RenderDeps; savePage takes the same deps.",
      "Cache keys are built only in src/render.ts."
    ],
    "constraints": [
      "The cache stays, with its ten-minute lifetime (REQUEST.md).",
      "The handbook runs as one process (README.md), so the in-process cache is the only copy to clear."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "A save clears every cached render it changes.",
      "files": [
        "src/render.ts",
        "src/editor.ts",
        "tests/editor.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In src/render.ts, export `pageCachePrefix(slug)`, which returns `page:${slug}`, and `sectionCacheKey(section)`, which returns `section:${section}`, and build the existing keys from them so the key shapes have one home.",
          "files": [
            "src/render.ts"
          ],
          "test_scenarios": [
            "tests/render.test.ts passes unchanged."
          ]
        },
        {
          "id": "t2",
          "description": "In savePage, after validation, read the previous version with `deps.pages.get(page.slug)`, then save. After the save, call `deps.cache.invalidate(pageCachePrefix(page.slug))`, which drops the html and print renders together, and `deps.cache.invalidate(sectionCacheKey(page.section))`. When the previous version exists and its section differs, also invalidate the previous section's key. A save that fails validation clears nothing.",
          "files": [
            "src/editor.ts",
            "tests/editor.test.ts"
          ],
          "test_scenarios": [
            "Render both views of a page, save a new body, render again: both views show the new body.",
            "Render the section index, save a new title, render the index again: it shows the new title.",
            "Move a page from boats to safety: the boats index no longer lists it and the safety index does.",
            "A save with an empty title throws EditError and the cached render of the page is still returned.",
            "Saving one page leaves the cached render of another page in place."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Run the handbook locally, open a page and its print view, edit the page, and reload both views and the sidebar."
    }
  ],
  "success_criteria": [
    "After a save, both views of the page and the affected section indexes show the new version on the next request.",
    "Unchanged pages keep their cached renders.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "savePage drops the cached views of the saved page and the index of every section it was or is in.",
        "completion_check": "tests/editor.test.ts covers both views, a title change, and a section move."
      }
    ]
  }
}
