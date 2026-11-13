{
  "schema_version": 1,
  "summary": "Make a quiet-hours change take effect at once: when the user saves new quiet hours, held notifications whose window has ended are sent immediately instead of at the next minute tick, and the settings screen shows when the held notifications will be delivered.",
  "context": {
    "key_files": [
      "src/preferences/parse.ts - Preferences, QuietHours, DEFAULT_PREFERENCES, and parsePreferences, the input boundary for the saved file and the form.",
      "src/preferences/store.ts - PreferencesStore: get, update (re-parses the merged value, persists, notifies listeners), subscribe.",
      "src/notify/scheduler.ts - isQuiet and NotificationScheduler (notify, flush, heldCount); reads preferences through getPreferences.",
      "src/ui/settings-form.ts - SettingsForm renders quiet hours from the store and submits through store.update.",
      "src/app.ts - createApp wires the store, scheduler, and form.",
      "tests/scheduler.test.ts, tests/parse.test.ts - Existing coverage."
    ],
    "patterns": [
      "PreferencesStore is the owner of preferences; every change goes through update.",
      "Times are HH:MM strings in the user's local time; overnight windows have start later than end."
    ],
    "constraints": [
      "The minute timer that calls flush stays.",
      "Quiet-hours parsing rules do not change."
    ],
    "project_docs": []
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Re-evaluate held notifications when quiet hours change, and record the next delivery time for the settings screen.",
      "files": [
        "src/preferences/parse.ts",
        "src/preferences/store.ts",
        "src/notify/scheduler.ts",
        "src/app.ts",
        "tests/store.test.ts",
        "tests/scheduler.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Give PreferencesStore an `attachScheduler(scheduler: NotificationScheduler)` method and call it from createApp. At the end of update(), after persist, call `await this.#scheduler?.reschedule(new Date())`, so a saved change reaches the scheduler before update resolves.",
          "files": [
            "src/preferences/store.ts",
            "src/app.ts",
            "tests/store.test.ts"
          ],
          "test_scenarios": [
            "Saving quiet hours that ended before now sends every held notification before update resolves."
          ]
        },
        {
          "id": "t2",
          "description": "Add `nextDeliveryAt?: string` (ISO time) to Preferences and pass it through parsePreferences. Add `NotificationScheduler.reschedule(now)`: it calls flush(now), then computes the next delivery time (the end of the current quiet window when notifications are still held, otherwise undefined) and writes it with `store.update({ nextDeliveryAt })`. The scheduler receives the store through a new constructor parameter. To stop the write from calling reschedule again, PreferencesStore sets a private `#rescheduling` flag around the call and skips reschedule while it is set.",
          "files": [
            "src/preferences/parse.ts",
            "src/preferences/store.ts",
            "src/notify/scheduler.ts",
            "tests/scheduler.test.ts"
          ],
          "test_scenarios": [
            "With one held notification at 23:00 and quiet hours to 07:00, nextDeliveryAt is 07:00 the next day.",
            "After every held notification is sent, nextDeliveryAt is undefined.",
            "The nextDeliveryAt write does not call reschedule a second time."
          ]
        }
      ],
      "verification": "bun test tests/store.test.ts tests/scheduler.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Harden the quiet-hours check and show the delivery time.",
      "files": [
        "src/notify/scheduler.ts",
        "src/ui/settings-form.ts",
        "tests/scheduler.test.ts",
        "tests/settings-form.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "In isQuiet, treat a missing preferences.quietHours, or a start or end that does not match HH:MM, as the window 22:00 to 07:00, so a corrupt preference can never wake the user at night.",
          "files": [
            "src/notify/scheduler.ts",
            "tests/scheduler.test.ts"
          ],
          "test_scenarios": [
            "isQuiet with quietHours undefined is true at 23:30 and false at 12:00.",
            "isQuiet with start \"9pm\" uses the default window."
          ]
        },
        {
          "id": "t2",
          "description": "Add `nextDelivery: string | undefined` to FormFields, read from store.get().nextDeliveryAt, so the settings screen shows \"Held notifications arrive at HH:MM\".",
          "files": [
            "src/ui/settings-form.ts",
            "tests/settings-form.test.ts"
          ],
          "test_scenarios": [
            "fields() returns nextDelivery after a notification is held.",
            "fields() returns nextDelivery undefined when nothing is held."
          ]
        }
      ],
      "verification": "bun test",
      "qualitative_verification": null
    }
  ],
  "success_criteria": [
    "Saving quiet hours that have already ended sends held notifications at once.",
    "The settings screen shows when held notifications will arrive.",
    "bun test passes."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "A quiet-hours change re-evaluates held notifications before the save completes.",
        "completion_check": "tests/store.test.ts asserts the held notification is sent before update resolves."
      },
      {
        "id": "d2",
        "text": "The settings screen shows the next delivery time.",
        "completion_check": "tests/settings-form.test.ts asserts nextDelivery."
      }
    ]
  }
}
