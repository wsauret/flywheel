{
  "schema_version": 1,
  "summary": "Add tag search to the notes CLI: a query word that starts with # matches the notes that carry that tag, and it combines with plain words (all terms must match). The search index gains a tag table, so its format moves to version 2.",
  "context": {
    "key_files": [
      "src/notes/store.ts - Note (with lower-cased tags parsed from the `tags:` line), parseNote, listNotes.",
      "src/search/build.ts - INDEX_VERSION, SearchIndex, tokenize, fingerprintOf, buildIndex.",
      "src/search/index-file.ts - loadIndex reads .notes-index.json or rebuilds it.",
      "src/search/query.ts - search(index, query): every query word must match.",
      "src/cli.ts - The `notes` command: lists the notes, loads the index, prints the hits.",
      "tests/index-file.test.ts, tests/query.test.ts - Existing coverage."
    ],
    "patterns": [
      "Index tables map a key to the sorted paths of the matching notes.",
      "Tests build notes with parseNote."
    ],
    "constraints": [
      "Plain-word search results do not change.",
      "Tags match case-insensitively, as parseNote already lower-cases them."
    ],
    "project_docs": []
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Index tags and keep existing index files usable.",
      "files": [
        "src/search/build.ts",
        "src/search/upgrade-v1.ts",
        "src/search/index-file.ts",
        "tests/build.test.ts",
        "tests/upgrade-v1.test.ts",
        "tests/index-file.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Set INDEX_VERSION to 2 and add `tags: Record<string, string[]>` (tag -> note paths) to SearchIndex. buildIndex fills it from note.tags.",
          "files": [
            "src/search/build.ts",
            "tests/build.test.ts"
          ],
          "test_scenarios": [
            "A note tagged garden appears under tags.garden.",
            "A note with no tags appears in no tag entry."
          ]
        },
        {
          "id": "t2",
          "description": "Add src/search/upgrade-v1.ts with a `SearchIndexV1` type (the version 1 shape) and `upgradeV1(index: SearchIndexV1, notes: readonly Note[]): SearchIndex`, which keeps the version 1 words table and adds the tags table from the notes. In loadIndex, when the cached file has version 1 and a matching fingerprint, return upgradeV1(cached, notes) and write it back, so users who upgrade keep their existing index instead of waiting for a full rebuild on their first search. Remove the converter after two releases.",
          "files": [
            "src/search/upgrade-v1.ts",
            "src/search/index-file.ts",
            "tests/upgrade-v1.test.ts",
            "tests/index-file.test.ts"
          ],
          "test_scenarios": [
            "A version 1 file with a matching fingerprint loads as version 2 with the same words and the notes' tags.",
            "The upgraded index is written back with version 2.",
            "A version 1 file with another fingerprint is rebuilt."
          ]
        }
      ],
      "verification": "bun test tests/build.test.ts tests/upgrade-v1.test.ts tests/index-file.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Match #tag terms in queries.",
      "files": [
        "src/search/query.ts",
        "tests/query.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In search, split the query on whitespace; a term that starts with # looks up index.tags with the rest of the term lower-cased, and every other term goes through tokenize and index.words as today. A note matches when it matches every term.",
          "files": [
            "src/search/query.ts",
            "tests/query.test.ts"
          ],
          "test_scenarios": [
            "#garden returns the notes tagged garden.",
            "#Garden matches the tag garden.",
            "#garden tomatoes returns only the tagged notes that contain tomatoes.",
            "A query without # terms returns the same results as before."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Run `notes #garden` against a folder with tagged notes and confirm the tagged paths print."
    }
  ],
  "success_criteria": [
    "notes #tag prints the notes with that tag; tag and word terms combine.",
    "Plain-word results are unchanged.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "A #tag term matches the notes that carry the tag.",
        "completion_check": "tests/query.test.ts covers tag-only and mixed queries."
      }
    ]
  }
}
