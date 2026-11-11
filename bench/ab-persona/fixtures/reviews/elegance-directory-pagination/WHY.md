# elegance-directory-pagination: control

This fixture seeds no defect. It is a clean change that contains things a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "fetchAllPages is a premature generic abstraction." It has two real callers in the same change, `listProjects` and `listMembers`, which follow the identical page protocol and differ only in path and item parser. Without it the cursor loop, page parsing, and cycle check would be written twice. The generic parameter is what lets both callers keep their typed results.
- "The repeated-cursor check is defensive code for an impossible state." The cursor is produced by another service, which is an external boundary; a server bug that repeats a cursor is a reachable state, and without the check the loop would never end. The comment states the risk.
- "parsePage / parseProject / parseMember repeat validation." Each checks a different shape of untrusted JSON exactly once at the boundary (the page envelope, then each item). Nothing re-validates downstream.
- "The `{ ...value }` spread into Record<string, unknown> is a workaround." It reads fields of a narrowed `object` without a type assertion, which the strict compiler settings require; it is the existing project pattern.
- "listProjects and listMembers are now one-line wrappers." They are the module's public API: they own the path of each list and its item parser, and `orgReport` depends on them. Inlining them would spread URL construction into callers.
