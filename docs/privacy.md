# What Flywheel sends over the network

Flywheel runs on your machine. It has no account with us, no analytics, and no usage tracking. This page lists every request that Flywheel makes on its own, what each request holds, and how to turn it off.

The Flywheel maintainers run Flywheel's hosted services: the bug report inbox and the remote access relay at `relay.flywl.sh`, and the hosted phone page at `remote.flywl.sh`. To reach the maintainers about a privacy matter, such as a request to delete a bug report, use the private channel in [SECURITY.md](../SECURITY.md): a [GitHub security advisory](https://github.com/wsauret/flywheel/security/advisories/new). Do not open a public issue for a private matter.

Your settings are in `~/.flywheel/flywheel.toml`. In the terminal, open Settings with `/settings`. In the web client, open Settings from the menu.

## Automatic bug reports

Official Flywheel releases send a bug report to the Flywheel maintainers when a client crashes or the background service reports a fault. The crash screen or fault notice says that a report was sent, shows the report id, and says where to turn automatic reports off. You can also send a report yourself with the `/report` command.

**To whom:** The report goes to `https://relay.flywl.sh/reports`, a Cloudflare Worker that the maintainers run. The Worker files the report as an issue in a private GitHub repository that only the maintainers can read. The Worker uses your IP address to limit how many reports one address can send. The Worker code does not store the address or put it in the report. It stores only daily counters: the number of reports of each kind and, for each crash, a hash of the error name, message, and stack, with the number of posts and the id of the latest report for that hash. The first report of a new day replaces the counters of the day before. Cloudflare's Workers Logs keep one invocation log for each request to the Worker, with the request URL, the request headers, and related metadata. Cloudflare adds your IP address to the request headers as `CF-Connecting-IP`, so the invocation log can hold your IP address. Cloudflare keeps these logs for 3 days on the Workers Free plan and 7 days on the Workers Paid plan, as its [Workers Logs documentation](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) states. The maintainers can read these logs.

**How long a report is kept:** a report is an issue in the private repository. It stays there until the maintainers delete it. Nothing deletes reports automatically.

**What a report holds:**

- The kind of report: a crash, or a report you sent with `/report`.
- The error name, message, and stack trace. Flywheel removes secrets such as API keys and tokens, and writes your home directory as `~`.
- The Flywheel version and build id, the operating system, and the processor architecture.
- The surface that failed: the terminal, the web client, the phone, the editor, or the background service.
- The id of the chat that was open. This is a random id, not its title or content.
- Up to 40 recent warning and failure records from each of the client, the background service, and the project process. A record holds only its time, its type, the name of the component, ids, counts, and timings.
- The note that you write, for a report that you send with `/report`.

**What a report never holds:** your conversations, prompts, model replies, tool output, file contents, environment variables, or credentials. The error message and stack trace are the only free text that Flywheel writes into a report. They can name a file path, with your home directory written as `~`, or a short piece of the value that caused the error.

**Which builds send reports:** Only builds from the official release pipeline send reports. The report address is not part of the program source. The official release machine supplies it when it builds the release. A local build, a source run, and a release that a fork builds have no address and send nothing, even when they crash. Their crash screen says that no report was sent and offers to copy the report.

**To turn it off:** turn off **Bug reports** in Settings. In the terminal it is in the Interface group. In the web client it is under Settings > Capabilities, in the Interface group. You can also add `"bug-reports"` to `disabled_modules` in `~/.flywheel/flywheel.toml`. When Bug reports is off, Flywheel sends no report, automatic or manual.

## Other automatic network traffic

Flywheel makes these requests on its own. None of them sends your conversations or files, except where this list says so.

| Traffic | When | Where it goes | What it sends | How to turn it off |
|---|---|---|---|---|
| Update check | About 10 seconds after the background service starts, then every 30 minutes. Only a build that names a release repository checks: an official release checks `wsauret/flywheel`, and a fork's release checks the fork's repository. A local build or a source run never checks, and its update status says so. | `github.com`, the release files of that repository | A plain download request with no Flywheel identifiers | No setting stops the check. Set `updates.auto_install = false`, or turn off Automatic Updates in Settings, to stop Flywheel from installing what it finds. |
| Release notes | Once, after an update installs | `api.github.com`, the release list of the same repository | A plain request with no Flywheel identifiers | No setting |
| Model catalog | When a login is first prepared, and when you open the model picker or the login screen, at most once every 5 minutes | `models.dev/catalog.json` | A plain request with no Flywheel identifiers | No setting. Flywheel uses a saved or bundled copy when the request fails. |
| Remote access relay | Only after you pair a phone or another device, or while a pairing code is open | `wss://relay.flywl.sh` | The machine's random id, name, and public key, the ids of paired devices, the Flywheel version, and for each project a hash of its path and its name. The traffic between your devices is end-to-end encrypted, so the relay cannot read your chats. The relay is the same Cloudflare Worker that receives bug reports, so Cloudflare's Workers Logs keep an invocation log for each connection, which can hold your IP address, for the period that Automatic bug reports states. | Turn off **Remote access** in Settings, or revoke every paired device. |
| Phone notifications | When a chat asks you a question that stays unanswered for 1.5 seconds, and a paired phone allowed notifications | The push service of the phone's browser, such as Apple's or Google's | An encrypted message with the machine name, the project name, the chat title, and a link | Turn off **Remote access**, or do not allow notifications on the phone. |
| Model lists, prices, and usage | When the model catalog refreshes, and every 5 minutes while a client is open for subscription usage | Only the model providers that you connected, and the OpenAI price page for OpenAI models | Your credentials for that provider, as each provider requires | Disconnect the provider or turn off its module. Turn off **Usage** in Settings to stop the background usage checks. |
| Login refresh | When a stored login expires | The provider that issued the login | The refresh token for that login | Remove the login. |

Requests to a model provider carry the prompts and files that you and your agents send to that provider. That traffic goes only to the providers that you connected, under their own privacy terms.

Some traffic happens only when an agent uses a tool. The web search tools send the search query to ChatGPT or Exa; turn off **Web** in Settings to remove them. The `models` tool downloads public benchmark scores at most once a day, and sends no data about you. It requests two files from `benchlm.ai` and the public Terminal-Bench leaderboard from `ofhuhcpkvzjlejydnvyd.supabase.co`. MCP servers receive what their tools need, and Flywheel connects only to the servers that you configured.

The bundled Claude engine runs with its own telemetry and automatic updates turned off.

