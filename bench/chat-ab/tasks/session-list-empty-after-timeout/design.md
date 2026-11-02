When a project opens slowly, the session list can stay empty until I restart the account service. Creating or renaming sessions does not recover it. Fix this without requiring a restart.

Keep recovery with the account service component that owns the project's session catalog. Use one ordered update path for the initial history and later session changes. A failed history read must not prevent later work from running. Until a history read succeeds, the next list request or session change must try it again. Once it succeeds, keep that baseline instead of reading the full history on every request.

Keep session changes queued while the baseline is unavailable, including changes received during the failed read. Apply those changes after the successful baseline so an older history result cannot overwrite a rename or hide a new session. Do not discard queued changes when a baseline attempt fails. Keep the existing error reporting; the failed request itself does not have to return a populated list.

Keep this focused on catalog recovery, not other session-list behavior. Run the relevant tests. Verify recovery through both a later request and a later session change, with no lost changes or repeated baseline reads after success.
