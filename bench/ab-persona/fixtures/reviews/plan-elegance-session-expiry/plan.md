{
  "schema_version": 1,
  "summary": "Add \"Keep me signed in\" to the login form: a session created with it lasts 30 days, any other session lasts 12 hours as today. The security team asked that a session keep the lifetime it was issued with, so a later change to either lifetime never shortens or extends sessions that already exist.",
  "context": {
    "key_files": [
      "migrations/001_sessions.sql - The sessions table (id, user_id, created_at).",
      "src/auth/sessions.ts - SESSION_TTL_MS, Session, SessionRepo, isExpired, createSession.",
      "src/auth/login.ts - handleLogin parses the body, creates the session, sets the sid cookie.",
      "src/auth/middleware.ts - requireSession, which calls isExpired.",
      "src/account/sessions-page.ts - activeSessions, which calls isExpired and shows createdAt as the sign-in time.",
      "src/jobs/sweep-sessions.ts - sweepSessions, the hourly delete of expired sessions.",
      "tests/sessions.test.ts - Existing coverage."
    ],
    "patterns": [
      "Times are milliseconds since the epoch; functions take `now` so tests can fix it.",
      "Schema changes ship as a numbered SQL migration."
    ],
    "constraints": [
      "Security team: a session keeps the lifetime it was issued with; changing either lifetime constant affects only sessions created afterwards.",
      "Sessions that exist when this ships keep their 12-hour lifetime.",
      "The account page keeps showing when each session signed in."
    ],
    "project_docs": []
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Give every session its own expiry time.",
      "files": [
        "migrations/002_session_expiry.sql",
        "src/auth/sessions.ts",
        "src/jobs/sweep-sessions.ts",
        "tests/sessions.test.ts",
        "tests/sweep-sessions.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add migrations/002_session_expiry.sql: `ALTER TABLE sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;` followed by `UPDATE sessions SET expires_at = created_at + 43200000;` (12 hours), so every existing session keeps the expiry it was issued with.",
          "files": [
            "migrations/002_session_expiry.sql"
          ],
          "test_scenarios": [
            "An existing row created at T has expires_at T + 43200000 after the migration."
          ]
        },
        {
          "id": "t2",
          "description": "Replace SESSION_TTL_MS with `STANDARD_SESSION_MS = 12 * 60 * 60 * 1000` and `REMEMBERED_SESSION_MS = 30 * 24 * 60 * 60 * 1000`. Session gets `expiresAt: number` and keeps createdAt for the account page. createSession takes `remember: boolean` and sets `expiresAt = now + (remember ? REMEMBERED_SESSION_MS : STANDARD_SESSION_MS)`. isExpired becomes `now >= session.expiresAt`, so requireSession and activeSessions keep calling it unchanged. Rename SessionRepo.deleteCreatedBefore to `deleteExpired(now)` (delete where expires_at <= now) and call it from sweepSessions.",
          "files": [
            "src/auth/sessions.ts",
            "src/jobs/sweep-sessions.ts",
            "tests/sessions.test.ts",
            "tests/sweep-sessions.test.ts"
          ],
          "test_scenarios": [
            "A remembered session is valid 29 days after creation and expired at 30 days.",
            "A standard session is expired at 12 hours.",
            "A session's expiry does not change when the lifetime constants change after it was created (the test builds a Session with an explicit expiresAt).",
            "sweepSessions deletes a remembered session only after its 30 days."
          ]
        }
      ],
      "verification": "bun test tests/sessions.test.ts tests/sweep-sessions.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Accept the choice at login.",
      "files": [
        "src/auth/login.ts",
        "tests/login.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In handleLogin, read `remember` from the body (true only when it is the boolean true) and pass it to createSession. For a remembered session, add `Max-Age=<lifetime in seconds>` to the sid cookie so it survives a browser restart; a standard session keeps a browser-session cookie as today.",
          "files": [
            "src/auth/login.ts",
            "tests/login.test.ts"
          ],
          "test_scenarios": [
            "Login with remember true sets a cookie with Max-Age=2592000 and a session that expires in 30 days.",
            "Login without remember sets no Max-Age and a 12-hour session.",
            "remember \"yes\" counts as false."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "\"Keep me signed in\" sessions last 30 days; others last 12 hours.",
    "Existing sessions keep their 12-hour lifetime.",
    "Changing a lifetime constant affects only new sessions.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "Each session stores the expiry it was issued with, and every expiry check reads it.",
        "completion_check": "isExpired and the sweep read expiresAt; tests cover both lifetimes."
      }
    ]
  }
}
