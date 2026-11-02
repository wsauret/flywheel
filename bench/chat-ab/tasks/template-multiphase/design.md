Please complete this template engine while preserving its public rendering, tokenization, and error APIs and typed token model. Keep the implementation self-contained.

I want three ordered phases, with focused tests passing before the next phase starts. First, make each template error message start with "Template error: ", followed by the original detail and " at position " with the source offset. Preserve the error name and position field.

Next, implement token recognition and a stack-based structural parser. Recognize literal text, ordinary escaped variables, triple-brace raw variables, and if and each opening and closing tags. Trim whitespace inside tag paths, preserve literal spans, and keep exact zero-based opening offsets. Empty input produces no tokens, and adjacent tags produce no empty text tokens. Match closing tags against the innermost open block. Unexpected or mismatched closings report the closing offset; an unclosed block reports its opening offset. Cover token offsets and nested structure before rendering integration.

Finally, render the parsed structure through the existing rendering entry point. Resolve dot-separated paths from the current scope. Missing or nullish values produce empty text; false and zero keep their normal string forms. Ordinary variables escape ampersands, angle brackets, double quotes, and single quotes without double escaping; triple braces remain raw.

Use ordinary JavaScript truthiness for if blocks and iterate only arrays for each blocks. Each item becomes the entire scope, with no parent-field fallback. Support arbitrary mixed and same-kind nesting. Do not evaluate a body omitted by a false parent. Keep parser internals private, add public integration tests, and verify each phase before you continue.
