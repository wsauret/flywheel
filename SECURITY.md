# Security Policy

## Supported versions

Only the latest published release receives security fixes. Flywheel updates itself, so staying current is one `flywheel update` away.

## Reporting a vulnerability

Report vulnerabilities privately through a [GitHub security advisory](https://github.com/wsauret/flywheel/security/advisories/new), or open the repository's Security tab and choose "Report a vulnerability". Do not open a public issue for a security report. You will get an acknowledgement within a few days.

## What Flywheel touches, so you can scope a report

- **Shell execution.** The agent runs shell commands and spawns processes on your machine with your permissions, and it does not ask before each one. Its guards prevent ordinary mistakes but are not a sandbox, so a command that escapes a guard is not by itself a vulnerability. Tool execution safety is specified in `docs/architecture-intent/tools.md`.
- **Credentials.** Provider API keys and OAuth tokens are stored under `~/.flywheel/auth/` and are held as redacted values in memory; they must never appear in logs, traces, error messages, or the event store. A credential appearing in any of those places is a vulnerability.
- **Local state.** Sessions, traces, and settings live in the project's `.flywheel/` directory and in `~/.flywheel/`. For model inference, your prompts and files go only to the model providers you configured. The tools that an agent uses can send user or project content to other destinations: an MCP server receives what its tool needs, a web search sends its query to ChatGPT or Exa, the `models` tool downloads public benchmark scores from `benchlm.ai` and a Terminal-Bench leaderboard on `supabase.co`, and a shell command can reach any host your machine can reach. Flywheel also makes these requests on its own: automatic bug reports to `relay.flywl.sh` from official release builds, the update check and release notes on GitHub, the public model catalog at `models.dev`, model lists, prices, usage, and login refreshes at the providers you connected, and the remote access relay at `relay.flywl.sh` and phone notifications after you pair a device. [What Flywheel sends over the network](docs/privacy.md) lists what each request holds and the controls that exist for it.
- **Release integrity.** Installers and the auto-updater verify downloaded release archives against the SHA-256 digests published by the release account. The digests come from the same GitHub release as the archives, so they detect a damaged download but not a compromised release account; release signing is not yet in place. Releases are published only by the maintainer's local operator command `bun run release`; GitHub Actions has no release role. A way to make a client accept an unverified payload is a vulnerability.
