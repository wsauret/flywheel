# plan-elegance-audit-sinks: control

This fixture seeds no defect. It is a clean plan that contains choices a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "AuditSink is a premature abstraction." It has two production implementations, and both are reachable: README.md describes the hosted container, whose stdout the platform collects, and the on-premises service, which needs a file. AUDIT_SINK picks one at startup. That is a real second implementation, not an extension point.
- "createAuditSink is a factory for nothing." It is the one switch over the `Config["audit"]` discriminated union, run once at startup; without it the composition would carry the same switch.
- "The AUDIT_SINK validation is defensive code." The environment is an external boundary, and parseConfig already validates PORT and DATA_DIR the same way, stopping startup with the variable's name.
- "recordAudit is a shallow wrapper over sink.write." It adds the one capability the routes need and the sinks do not have: the best-effort rule from the constraint (a failed write never changes the response and is reported on stderr). It has two callers, so the rule lives in one place instead of a try/catch in each route.
- "Catching the write error hides failures." The operators asked for best effort, and every failure is reported on stderr with its action and target.
- "The test sink is a third implementation." It is an object literal in a test, the existing pattern for `UserDirectory` in tests/routes.test.ts.
- "AUDIT_FILE with a DATA_DIR default is Config Soup." It is one optional path for one variant; the union keeps the valid combinations explicit.
- The plan reuses `nowIso` from src/lib/clock.ts rather than formatting time itself.
