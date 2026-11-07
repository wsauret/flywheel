# Reference answer: the escapes that VALID_JSON_ESCAPES lists

All line numbers refer to the fixture checkout: the public base commit `85c69871d` with the task's `sandbox.patch` applied.

`VALID_JSON_ESCAPES` at `src/orchestration/agent-runtime/llm/json-parse.ts:20` is a set of nine characters: the double quote, the backslash, the forward slash, and `b`, `f`, `n`, `r`, `t`, and `u`. These are the characters that JSON allows after a backslash. A one-sentence answer that names these nine characters is complete.
