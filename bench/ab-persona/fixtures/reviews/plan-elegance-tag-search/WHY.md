# plan-elegance-tag-search: seeded defect rationale

## derived-index-v1-converter (phase-1/t2)

The index file is a cache: the comment on `loadIndex` says a file of another version is "replaced with a fresh build; there is nothing in it that the notes do not hold", `listNotes` calls the notes "the only source of truth; the index is derived from them", and the existing test proves that an old version is rebuilt. Raising `INDEX_VERSION` to 2 is therefore the whole migration. The plan adds a version 1 type, a converter, a loadIndex branch, three tests, and a removal date, to spare users "a full rebuild on their first search". The rebuild costs nothing the converter avoids: `loadIndex` receives every parsed note in memory, the converter itself must walk them for the tags, and `buildIndex` only tokenizes text the process already read. The plan looks responsible because converting old on-disk formats with a dated removal is good practice for durable user state; the index is not durable user state.

## What is intended

- A `tags` table in the index and a version bump are the right shape for tag lookups.
- Splitting the query on whitespace and treating a leading # as a tag term keeps plain-word behavior unchanged.
- Lower-casing the tag term matches how `parseNote` stores tags.
