# elegance-user-settings: control

This fixture seeds no defect. It is a clean change that contains several things a reflexive structural reviewer tends to flag. Each is correct here.

## Tempting findings that are wrong

- "Defensive checks in parseSettingsFile (typeof, Array.isArray, the JSON.parse try/catch)." The settings file is written by hand by the user. It is an external boundary, the one place where untrusted input becomes the typed `Settings`, and every check has a reachable producer: a typo, a stray array, a trailing comma. Each failure becomes an error that names the file and the key. Nothing downstream repeats the checks.
- "Defaults for absent fields / returning defaults when the file is missing." A missing file and a missing key are both normal, supported states for a user who never wrote a settings file or set only one value. The defaults come from the one existing source, `DEFAULT_SETTINGS`; nothing is restated.
- "Unknown keys should be ignored for forward compatibility" or the opposite, "rejecting unknown keys is hostile." The file has one reader and no other writer, so a key this code does not know is a typo; refusing it is the point, and the doc comment says so.
- "The weekStartsOn check restates the allowed values." It searches `WEEK_STARTS`, the one runtime list in settings.ts from which the `WeekStart` type is derived, so a new value needs one edit.
- "isTimeZone is a hand-rolled validator / swallows errors." It asks the runtime's own time zone database through `Intl.DateTimeFormat`, which is the authority on valid names; the caught error is the answer to the question, not a hidden failure.
- "readIfPresent catches errors." It turns exactly one external condition, a missing file (ENOENT), into `undefined` and rethrows everything else.
- "Copy of DEFAULT_SETTINGS." The copy is the value that parsing fills in; it is not a second source of truth.
