{
  "schema_version": 1,
  "summary": "Record an audit event for every successful admin action (user removed, role changed). Both deployments need it: the hosted container writes audit events to stdout, where the platform collects them, and the on-premises package appends them to a JSON Lines file that customers' log shippers read. The deployment chooses with AUDIT_SINK.",
  "context": {
    "key_files": [
      "README.md - The two deployments: hosted container (stdout collected) and on-premises service (DATA_DIR).",
      "src/config.ts - Config and parseConfig, the environment boundary.",
      "src/admin/routes.ts - handleRemoveUser and handleSetRole with AdminContext.",
      "src/lib/clock.ts - nowIso.",
      "src/server.ts - startServer, the composition root: parses the config once and builds the AdminContext of each request.",
      "tests/routes.test.ts, tests/config.test.ts - Existing coverage."
    ],
    "patterns": [
      "Configuration is parsed once from the environment; a bad value stops startup with the variable's name.",
      "Routes receive their collaborators through AdminContext."
    ],
    "constraints": [
      "An audit event holds the time, the actor id, the action, and the target user id; never request bodies.",
      "Audit is best effort, as the operators asked: an action's response never depends on the audit write. A failed write is reported on stderr with the action and target, and the action's response is unchanged.",
      "Audit events are written only after the action succeeded."
    ],
    "project_docs": [
      "README.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Configure and build the audit sink.",
      "files": [
        "src/config.ts",
        "src/audit/sink.ts",
        "tests/config.test.ts",
        "tests/sink.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `audit: { kind: \"stdout\" } | { kind: \"file\"; path: string }` to Config. parseConfig reads AUDIT_SINK (\"stdout\" when unset, or \"file\"); for \"file\" the path is AUDIT_FILE, or `<DATA_DIR>/audit.jsonl` when AUDIT_FILE is unset. Any other AUDIT_SINK value throws `AUDIT_SINK must be stdout or file`.",
          "files": [
            "src/config.ts",
            "tests/config.test.ts"
          ],
          "test_scenarios": [
            "No AUDIT_SINK gives { kind: \"stdout\" }.",
            "AUDIT_SINK=file without AUDIT_FILE gives the path under DATA_DIR.",
            "AUDIT_SINK=syslog throws a message that names AUDIT_SINK."
          ]
        },
        {
          "id": "t2",
          "description": "Add src/audit/sink.ts: `AuditEvent` ({ at, actorId, action: \"user.removed\" | \"user.role_changed\", targetId, role? }), `interface AuditSink { write(event: AuditEvent): Promise<void> }`, a stdout implementation that writes one JSON line to process.stdout, a file implementation that appends one JSON line with appendFile from node:fs/promises, `createAuditSink(audit: Config[\"audit\"]): AuditSink`, which switches on audit.kind, and `recordAudit(sink: AuditSink, event: AuditEvent): Promise<void>`, the one owner of the best-effort rule: it awaits sink.write and reports a rejection on stderr with the action and target instead of rethrowing.",
          "files": [
            "src/audit/sink.ts",
            "tests/sink.test.ts"
          ],
          "test_scenarios": [
            "The file sink appends one parseable JSON line per event to a file in a temporary directory.",
            "createAuditSink returns the file sink for kind file and the stdout sink for kind stdout.",
            "recordAudit with a sink whose write rejects resolves and reports the action and target on stderr."
          ]
        }
      ],
      "verification": "bun test tests/config.test.ts tests/sink.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Record the admin actions.",
      "files": [
        "src/admin/routes.ts",
        "src/server.ts",
        "tests/routes.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `audit: AuditSink` to AdminContext. startServer calls createAuditSink(config.audit) once after parseConfig and puts the sink into every AdminContext. After a successful remove or role change, each route awaits `recordAudit(context.audit, { at: nowIso(), actorId: context.actorId, action, targetId: userId, ... })` and then returns its usual 204. Tests pass an object literal sink that pushes events into an array.",
          "files": [
            "src/admin/routes.ts",
            "src/server.ts",
            "tests/routes.test.ts"
          ],
          "test_scenarios": [
            "Removing a user records one user.removed event with the actor and target.",
            "Changing a role records user.role_changed with the new role.",
            "A 404 or 400 response records no event.",
            "A sink whose write rejects still gives the 204 response."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Every successful admin action writes one audit event to the configured sink.",
    "Hosted deployments see the events on stdout; on-premises deployments get audit.jsonl.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "Successful admin actions write an audit event; failed ones do not.",
        "completion_check": "tests/routes.test.ts covers both."
      },
      {
        "id": "d2",
        "text": "AUDIT_SINK selects stdout or a JSON Lines file.",
        "completion_check": "tests/config.test.ts and tests/sink.test.ts cover both kinds."
      }
    ]
  }
}
