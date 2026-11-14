# Why this task exists

This question restores the behavior of fix f37916a3a (read an edit call written in mixed parameter syntax). The answer is a set of conditions and a counterexample: the repair accepts one narrow shape, reads old and new text differently, and the streaming preview reads only JSON, although a nearby comment says every reader sees what execution applies. The answer key lives only in `manifest.json` and this file, which the trial cannot read: its corpus is the pin, restricted to `src, AGENTS.md, docs/architecture.md, docs/architecture-intent, docs/product-intent, docs/terminology.md`.

## Verification at the pinned tree

Every reference below is `path:line` at commit `74d097f9c661f2e3b1e01c1731d69b6aa8dc2039`, with a snippet that occurs on that line or range. The snippets were checked mechanically against the pinned extract.

### Fact `one-open-entry`

Only one shape is repaired: a single open-ended entry whose text opens with the old-text key, has exactly one separator to the new-text key, and ends with that key's string value and no closing bracket; anything more is refused.

- `src/orchestration/agent-runtime/tools/coerce-input.ts:285`: `mixedSyntaxEntry(value, schema.items)`
- `src/orchestration/agent-runtime/tools/coerce-input.ts:315`: `more.length > 0) return undefined;`

### Fact `new-text-json`

The new text is read as a JSON string; a tail that is not one closed JSON string is refused.

- `src/orchestration/agent-runtime/tools/coerce-input.ts:318`: `second = JSON.parse(`
- `src/orchestration/agent-runtime/tools/coerce-input.ts:322`: `typeof second === "string" ?`

### Fact `old-text-raw`

The old text is kept raw, not decoded: an escape such as backslash-n stays two characters.

- `src/orchestration/agent-runtime/tools/coerce-input.ts:322`: `head.slice(opening.length)`

### Fact `dispatch-coerces`

Dispatch coerces the call before validation, and execution reads the coerced list, so an accepted mixed call executes as a normal edit.

- `src/orchestration/agent-runtime/tools/tool-dispatch.ts:256`: `const input = coerceToolInput(call.input, inputSchema`
- `src/orchestration/agent-runtime/tools/edit.ts:75`: `const edits = parseStringEdits(input.edits);`

### Fact `preview-json-only`

The streaming validator and the diff preview read the edits list only as JSON text, so they see no entry for a mixed call that the tool applies.

- `src/infra/file-edit/edit-input.ts:26`: `readJsonValue(edits)?.value : edits`
- `src/orchestration/agent-runtime/tools/streaming-edit-validator.ts:151`: `parseStringEdits(editInputEntries(decoder.fields))`

### Trap `all-mixed-applied`

Wrong answer: Every edit call written in mixed syntax is repaired and applied.

Why a shallow trace reaches it: The coercion layer wires a repair for the edit list.

Misleading evidence:

- `src/orchestration/agent-runtime/tools/coerce-input.ts:285`: `mixedSyntaxEntry(value, schema.items)`

Refuted by:

- `src/orchestration/agent-runtime/tools/coerce-input.ts:315`: `more.length > 0) return undefined;`
- `src/orchestration/agent-runtime/tools/coerce-input.ts:318`: `second = JSON.parse(`

### Trap `preview-matches`

Wrong answer: The streaming preview shows the same replacement that the tool applies.

Why a shallow trace reaches it: A comment in the shared edit-input reader says every reader of a recorded or streaming call sees the entries that execution applies.

Refuted by:

- `src/infra/file-edit/edit-input.ts:26`: `readJsonValue(edits)?.value : edits`

### Trap `both-decoded`

Wrong answer: Old and new texts are both JSON-decoded, so an escaped newline in the old text matches a real newline.

Why a shallow trace reaches it: The repair parses the tail as JSON, so a reader assumes it parses both sides.

Refuted by:

- `src/orchestration/agent-runtime/tools/coerce-input.ts:322`: `head.slice(opening.length)`
