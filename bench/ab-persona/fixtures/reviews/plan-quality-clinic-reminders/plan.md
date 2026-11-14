{
  "schema_version": 1,
  "summary": "Add SMS reminders to the reminder pass and show appointment times in the clinic's local time, as REQUEST.md asks. formatSlot takes the clinic's time zone, the email and the new SMS both use it, and the pass sends the SMS in the same step that sends the email, so the existing once-per-appointment marker covers both.",
  "context": {
    "key_files": [
      "REQUEST.md - The practice managers' request.",
      "src/reminders/pass.ts - runReminderPass: finds unreminded appointments that start 24 hours from now, emails each patient, then marks the appointment reminded. A failure is reported per appointment and the pass goes on.",
      "src/format.ts - formatSlot, which formats an appointment start in UTC today.",
      "src/patients/phone.ts - normalizePhone, which turns a typed mobile number into the E.164 form the gateway needs and returns null when the input is not a valid mobile number.",
      "src/sms/gateway.ts - SmsGateway, already used for sign-in codes.",
      "src/clinics.ts - Clinic, which carries the clinic's IANA time zone.",
      "tests/pass.test.ts, tests/format.test.ts, tests/fakes.ts - Existing coverage and the in-memory dependencies."
    ],
    "patterns": [
      "The pass takes its channels through ReminderDeps; tests record sends in arrays on fakeDeps.",
      "Patient-facing dates go through formatSlot only."
    ],
    "constraints": [
      "One reminder pass per appointment, as today: the remindedAt marker is set after the messages go out.",
      "Handling the C reply is out of scope (REQUEST.md).",
      "No SMS to a number that is not a valid mobile number."
    ],
    "project_docs": [
      "README.md",
      "REQUEST.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Appointment times are shown in the clinic's local time.",
      "files": [
        "src/format.ts",
        "src/reminders/pass.ts",
        "tests/format.test.ts",
        "tests/pass.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Change formatSlot to `formatSlot(startsAt: Date, timeZone: string)` and pass timeZone to Intl.DateTimeFormat in place of the fixed \"UTC\". formatSlot has one caller, the email body in runReminderPass; pass clinic.timeZone there.",
          "files": [
            "src/format.ts",
            "src/reminders/pass.ts",
            "tests/format.test.ts"
          ],
          "test_scenarios": [
            "formatSlot(2027-01-12T09:30:00Z, \"Europe/London\") is \"Tue 12 Jan 2027, 09:30\": this proves the clinic's time zone is applied.",
            "The existing format test passes \"Europe/London\" and keeps its expected text."
          ]
        },
        {
          "id": "t2",
          "description": "In tests/pass.test.ts, assert the email body of the existing first test contains the clinic-local time.",
          "files": [
            "tests/pass.test.ts"
          ],
          "test_scenarios": [
            "The reminder email for the Europe/London clinic's 2027-01-12T09:30:00Z appointment contains \"Tue 12 Jan 2027, 09:30\"."
          ]
        }
      ],
      "verification": "bun test tests/format.test.ts tests/pass.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "The pass sends an SMS reminder to every patient with a valid mobile number.",
      "files": [
        "src/reminders/pass.ts",
        "tests/fakes.ts",
        "tests/pass.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add `sms: SmsGateway` to ReminderDeps and an `sms` array plus a recording gateway to fakeDeps. In runReminderPass, after the email and before markReminded, compute `const mobile = patient.mobile === undefined ? null : normalizePhone(patient.mobile)`. When mobile is not null, send `Reminder: your appointment at ${clinic.name} is on ${formatSlot(appointment.startsAt, clinic.timeZone)}. Reply C to cancel.` to it. A null result covers both the missing and the invalid number, so no separate validation is needed.",
          "files": [
            "src/reminders/pass.ts",
            "tests/fakes.ts",
            "tests/pass.test.ts"
          ],
          "test_scenarios": [
            "A patient with an email and a mobile number gets one email and one SMS with the request's text.",
            "A patient without a mobile number gets the email and no SMS.",
            "A patient whose mobile is \"12345\" gets the email and no SMS.",
            "A patient without an email but with a mobile number gets the SMS only.",
            "A second pass five minutes later sends nothing for the same appointment."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Patients with a valid mobile number get an SMS reminder 24 hours before the appointment.",
    "No appointment is reminded twice.",
    "The email and the SMS show the clinic's local time.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "formatSlot formats in the clinic's time zone.",
        "completion_check": "tests/format.test.ts covers a named clinic time zone."
      },
      {
        "id": "d2",
        "text": "runReminderPass sends the SMS to valid mobile numbers only, inside the existing once-per-appointment pass.",
        "completion_check": "tests/pass.test.ts covers the SMS, no-mobile, and second-pass cases."
      }
    ]
  }
}
