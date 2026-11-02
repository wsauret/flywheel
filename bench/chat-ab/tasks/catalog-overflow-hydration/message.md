In a project with a few thousand sessions, the session list sometimes never finishes loading on a client that is slow to keep up, like my phone on a weak connection or a busy browser tab right after the runtime starts. Many rows keep their loading state for totals forever, and some rows show stale data.

Nothing fixes it except disconnecting and reconnecting the client, or waiting until that particular session changes again. The connection itself stays up the whole time.

A client that falls behind must catch back up on its own, without a reconnect, and without hanging up on slow clients.
