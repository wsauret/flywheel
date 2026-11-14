{
  "schema_version": 1,
  "summary": "Upload a nightly CSV of new and changed members to the federation, as REQUEST.md asks. Members are selected by updatedAt against a stored watermark, so the first run sends everyone and later runs send only what changed.",
  "context": {
    "key_files": [
      "REQUEST.md - The club secretary's request.",
      "src/members.ts - Member and MemberStore. The store stamps updatedAt on every write: create, an officer's update, and the payment sync's setStatus, so updatedAt is the time of the member's latest change of any kind.",
      "src/settings.ts - The Settings key-value port for the service's own state.",
      "src/federation/client.ts - FederationClient.uploadMembers, which throws FederationError when the registry refuses an upload.",
      "src/scheduler.ts - Scheduler.nightly: runs a job at 02:00; a thrown error is logged and the job runs again the next night.",
      "tests/members.test.ts - Existing store coverage."
    ],
    "patterns": [
      "Jobs take their dependencies as one deps object and a clock, so tests drive time.",
      "Persistent service state goes through Settings under a dotted key."
    ],
    "constraints": [
      "CSV columns in the request's order: member_id, name, membership_type, status.",
      "The member store and the payment sync do not change."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Select changed members and write the federation CSV.",
      "files": [
        "src/federation/export.ts",
        "tests/export.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `changedSince(members: readonly Member[], since: Date): Member[]` in src/federation/export.ts, which keeps the members whose updatedAt is at or after since, ordered by id. A member changed in the same millisecond as the previous run's start is sent again rather than missed. Because every store write stamps updatedAt, this catches new members, officer edits, and status changes alike.",
          "files": [
            "src/federation/export.ts",
            "tests/export.test.ts"
          ],
          "test_scenarios": [
            "A member created after since is selected.",
            "A member edited by an officer after since is selected.",
            "A member whose status the payment sync set to lapsed after since is selected.",
            "A member untouched since then is not selected.",
            "The result is ordered by id."
          ]
        },
        {
          "id": "t2",
          "description": "Add `toMemberCsv(members)`: a header line `member_id,name,membership_type,status`, then one line per member, CRLF line ends. A field that contains a comma, a double quote, or a line break is quoted and its double quotes doubled.",
          "files": [
            "src/federation/export.ts",
            "tests/export.test.ts"
          ],
          "test_scenarios": [
            "Two members give the header and two lines in order.",
            "The name Ana \"Wheels\" Ortiz, Jr. is written as \"Ana \"\"Wheels\"\" Ortiz, Jr.\"."
          ]
        }
      ],
      "verification": "bun test tests/export.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Run the export every night.",
      "files": [
        "src/federation/export-job.ts",
        "src/jobs.ts",
        "tests/export-job.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `runMemberExport(deps: { members: MemberStore; settings: Settings; federation: FederationClient; now: () => Date })` in src/federation/export-job.ts. Read the watermark from settings key `federation.lastExportAt` (an ISO time; absent means the epoch, so the first run sends everyone). Take `startedAt = deps.now()`, select `changedSince(deps.members.all(), since)`, then store startedAt as the new watermark, then upload `toMemberCsv(changed)` when changed is not empty. The watermark is stored before the upload so a slow upload can never make the next night's run send the same rows a second time.",
          "files": [
            "src/federation/export-job.ts",
            "tests/export-job.test.ts"
          ],
          "test_scenarios": [
            "The first run uploads every member and stores the watermark.",
            "A second run after one officer edit uploads only that member.",
            "A run with no changes uploads nothing and moves the watermark."
          ]
        },
        {
          "id": "t2",
          "description": "Add `registerJobs(scheduler, deps)` in src/jobs.ts, which calls `scheduler.nightly(\"federation-member-export\", () => runMemberExport(deps))`.",
          "files": [
            "src/jobs.ts",
            "tests/export-job.test.ts"
          ],
          "test_scenarios": [
            "registerJobs registers one nightly job named federation-member-export."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": "Run runMemberExport once against the federation's test registry and check the uploaded file."
    }
  ],
  "success_criteria": [
    "Every night the federation receives the members created or changed since the last export, status changes included.",
    "The first export carries every member.",
    "The CSV has the four columns in the request's order and quotes fields correctly.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "runMemberExport sends every member changed since the stored watermark.",
        "completion_check": "tests/export-job.test.ts covers the first run, an incremental run, and an empty run."
      },
      {
        "id": "d2",
        "text": "The export runs nightly.",
        "completion_check": "tests/export-job.test.ts asserts the nightly registration."
      }
    ]
  }
}
