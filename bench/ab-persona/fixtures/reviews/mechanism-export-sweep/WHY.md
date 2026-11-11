# mechanism-export-sweep: claim ground truth (control)

Plan review, control fixture: all five claims are true. Claims 1, 3, and 5 look doubtful on a skim. Any refutation is an unsupported finding.

## Claim 1: TRUE (looks doubtful)

A reader may suspect that the suffix check `endsWith(".csv")` also matches a temporary file. The writer opens `<id>.csv.partial` (writer.ts:5, writer.ts:16-17), and that name ends in `.partial`, not `.csv`, so sweepOnce skips it before it reads the age (sweeper.ts:15). The file gets the final name only through the rename after the sync (writer.ts:20-27). Age does not matter, because the skip comes before the mtime check at sweeper.ts:19. The probe ran a sweep with retention 0 and a clock one year ahead while a write was paused: it deleted nothing, and the `.partial` file survived and was renamed afterwards.

## Claim 2: TRUE

writeExport writes every row, then calls `handle.sync()` (writer.ts:19-20), closes the handle, and only then renames the temporary file to the final name (writer.ts:26-27). On a failure it closes the handle, removes the temporary file, and rethrows (writer.ts:21-25), so the rename never runs for a partial export. The rename replaces the name in one step, so a reader opens either nothing or the complete synced file. The probe listed the directory during a paused write and saw only `export-0001.csv.partial`.

## Claim 3: TRUE (looks doubtful)

A reader may assume an interval timer. startSweeper schedules the next run with `setTimeout` inside the `finally` of the current run (sweeper.ts:43-50), after `await sweepOnce` has settled. The first run starts once (sweeper.ts:52). There is never more than one pending timer or running sweep, whatever the interval. The probe slowed each directory read to 30 ms with an interval of 1 ms: 6 to 7 sweeps ran in 200 ms across runs, and at most 1 was in progress at a time.

## Claim 4: TRUE

serveDownload opens the file directly (downloads.ts:18) and maps ENOENT from open to 404 (downloads.ts:19-21). There is no separate existence check before the open, so no check-then-open gap. The probe let the sweeper delete an old export and then requested it: 404. A present export returned 200.

## Claim 5: TRUE (looks doubtful)

During a sweep no timer is pending, so the `clearTimeout` in stop (sweeper.ts:56) has nothing to clear, which makes stop look ineffective. stop also sets `stopped = true` (sweeper.ts:55), and the running sweep checks that flag in its `finally` before it schedules the next run (sweeper.ts:49), so it schedules none. If stop runs while a timer is pending, clearTimeout cancels it. The probe called stop while the first sweep was in its directory read; after 150 ms, 1 sweep had run in total.

## Behavior outside the claims

A file that the sweep cannot stat or delete, for example one that is locked or not writable, goes to `onError` and the sweep continues with the next file (sweeper.ts:22-23), so one bad file never stops the deletion of the others. Such a file stays until it can be deleted, and each sweep reports it again; that is the expected limit of any sweeper, not a defect of this control.
