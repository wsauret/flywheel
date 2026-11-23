Method:

You are the only author of these release notes. No person reads them before they are published. Thus every statement in the notes must be true for the code at the head commit, and you must verify each statement yourself. Work read-only: do not change files in the checkout, and do not commit or push.

The working directory is a checkout of the head commit, and git can read every commit and tag of the repository. Use git and the source files as evidence. The release evidence file lists the commits of the release range. A commit message tells what a commit intended; only the code at the head tells what ships.

1. Build a ledger of feature families

- Read the evidence file in full. It is newest first. Build the ledger oldest commit first
- Put each user-facing commit into a feature family. A feature family is one capability that a user can see or use. Group by capability, not by commit type, scope, changed path, or implementation unit. The runtime, client, transport, recovery, safety, and performance work that make one capability operate are parts of the same family
- For each family, record its final state at the head commit
- When a later commit in the range removed or reverted the capability, or the capability never shipped, omit the family entirely. Do this also when a feat commit introduced it
- When a later commit renamed or redesigned the capability, describe only its final form
- Verify each final state with git: read the later commits of the range that touch the family (`git log <base>..<head> -- <path>`), and search the head for its commands, flags, settings, and module names (`git grep <term> <head>`)

2. Select the section of each family

- Put an entry under Fixed, Changed, or Performance only when git shows that the affected capability already existed at the base tag. Examine the base with `git show <base>:<path>` or `git grep <term> <base>`
- When the capability did not exist at the base tag, it is new in this release. Merge all of its fixes, redesigns, and improvements into one Added entry for that family, and do not put the family in another section. Do not say that the capability was broken, incomplete, or different during the range
- A fix for a defect that a commit in the same range introduced is not a release note. Omit it
- When there is no previous release, every capability is new. Use only Added

3. Verify every detail

- Confirm in the code at the head every specific detail of an entry: commands, flags, key bindings, setting names, model ids, defaults, thresholds, counts, and percentages. When you cannot confirm a detail, remove it
- Use a measured number only when the evidence states it and the measurement was on code that ships in this release. When the measurement was on one project or one setup, say so
- Do not make a fix more general than the code. Name the client, provider, platform, or condition that the code limits it to
- Describe a mechanism only when you verified it and a user needs it to understand or use the change
- Omit CI, build, release, benchmark, test-only, repository-tooling, and internal refactor work. Omit prompt and guidance changes that users do not notice

4. Use subagents to verify

- Divide the ledger into batches of families. Give each batch to a subagent, and run these subagents in parallel. Give each subagent the evidence file path, the base tag, the head commit, and rules 1 to 3. Each subagent returns one verdict for each claim (supported, false, unsupported, wrong section, or removed at the head) with the commit hashes and the `file:line` evidence
- Write the notes from the verified verdicts
- Then give the notes to one independent subagent that did not write or verify them. Give it the evidence file path, the base tag, the head commit, and rules 1 to 3. Tell it to examine each clause against the code and to report each false, unsupported, wrong-section, or duplicate entry, and each material user-facing change that the notes do not include
- Correct each finding that you confirm. Then return the result
- You can use a workflow instead of subagents only when it is clearly better. Both are permitted

5. Style

- Start with a summary paragraph of two or three sentences about the theme of the release
- Use only the sections Added, Fixed, Changed, and Performance, in that order. Do not include an empty section
- Write one line for each entry, imperative or declarative. Put the most significant entries first in each section
- Do not use a trailing period, marketing language, exclamation marks, emojis, or em dashes
- Do not write commit hashes, scopes, file names, or internal module names in the notes

6. Result

- Your final message is only the JSON result that the task specifies. Do not write other text in that message
