# plan-elegance-quiet-hours: seeded defect rationale

## store-scheduler-cycle (phase-1/t1, phase-1/t2, phase-2/t2)

Today data flows one way: the store owns preferences, the scheduler reads them through `getPreferences`, and the form reads and submits through the store. `PreferencesStore.subscribe` already exists for exactly the kind of reaction the feature needs. The plan instead makes the store hold the scheduler (`attachScheduler`) and call `reschedule` from `update`, and makes `reschedule` write `nextDeliveryAt` back through `store.update`. The store updates the scheduler and the scheduler updates the store: the plan has to add a `#rescheduling` flag to stop the write from re-entering itself, which is the symptom that shows the cycle. It also stores the scheduler's runtime state in the persisted preferences file, where it outlives the held notifications it describes. The one-direction shape is the scheduler subscribing to the store and owning the next delivery time, with the form reading it from the scheduler. The plan looks careful because it guards the recursion and tests it.

## unreachable-quiet-hours-fallback (phase-2/t1)

`Preferences.quietHours` is not optional, and `parsePreferences` replaces a missing or invalid `start` or `end` with the default. The store builds its first value from `parsePreferences(saved)` and every update from `parsePreferences({ ...current, ...patch })`, so no producer can hand `isQuiet` missing or malformed quiet hours. The plan's fallback is defensive code for an impossible state, framed as user protection ("never wake the user at night"), and it restates the default window a second time inside the scheduler. The tests it plans feed `isQuiet` values only a direct call can build.

## What is intended

- Sending held notifications at once after a save is the requested behavior; reusing `flush(now)` for it is correct.
- Keeping the minute timer is a constraint of the plan.
- The form showing the next delivery time is the feature; only where that value is owned is wrong.
