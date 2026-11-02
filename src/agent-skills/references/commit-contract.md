# Commit Contract

Follow the target repository's commit convention when one is documented. Otherwise, write a concise subject that describes the outcome. Do not assume a type vocabulary, release-note format, trailer, or subject-length limit.

When the repository generates release notes from commits, follow its rules for user-facing subjects and internal changes. Describe breaking changes and required user action when applicable, using the repository's convention if it defines one.

Group one complete unit per commit; supporting tests and refactors ride with that unit. Never use a miscellaneous grouping.

Run the repository's commit-message validator if it defines one. Do not assume a particular command, script path, or runtime.