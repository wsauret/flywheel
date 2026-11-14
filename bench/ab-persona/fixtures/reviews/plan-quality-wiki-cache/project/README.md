# club-handbook

The members' handbook of the Lakeside Rowing Club: a small wiki of pages grouped in sections. It runs as one process on one server.

- `src/pages.ts` stores pages.
- `src/render.ts` renders a page (normal and print views) and the section index, the sidebar list of the pages in a section. Both are cached in `src/cache.ts`, because rendering the Markdown is slow on the club's server.
- `src/editor.ts` saves an edited page.

Tests run with `bun test`.
