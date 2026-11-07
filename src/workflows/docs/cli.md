# Flywheel command line reference

This file is generated from the command definitions. Run `bun run docs:generate` to update it.

## Usage

```text
flywheel [options]
flywheel <subcommand> [args]
flywheel --headless [--session <id>] [--one-shot] [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>] [--jsonl]
flywheel --headless --acp [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>]
flywheel --headless --task <text> [--system-prompt <text>] [--model <id|tier>] [--effort <level>] [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>] [--deadline-seconds <seconds>] [--jsonl]
```

Running flywheel with no arguments starts the interactive TUI. An explicit --project-root or FLYWHEEL_PROJECT_ROOT wins, then an established ancestor .flywheel directory. Otherwise, an interactive terminal chooses between the nearest Git root and starting directory before project services start. Once .flywheel is created, later launches discover and reuse that project root. Silent and headless invocations use the same explicit and established precedence, then silently use the nearest Git root or current directory. The account home is a project only when --project-root names it. A terminal paired with another machine also offers that machine's projects when it asks. Account-global settings live in ~/.flywheel/flywheel.toml.

## Options

| Option | Description |
| --- | --- |
| `-h, --help` | Show this help and exit. |
| `-v, --version` | Print the Flywheel version and exit. |
| `--project-root <dir>` | Directory that owns durable project state. Overrides FLYWHEEL_PROJECT_ROOT, established .flywheel discovery, and interactive or silent fallback selection. |
| `--remote` | Choose a project on a machine this terminal is paired with, and open it through the relay. Pair a machine with 'flywheel remote machines add `<link>`'. |
| `--print-logs` | Mirror structured logs to stderr. While the TUI draws on the terminal, only a redirected stderr gets them. |
| `--headless` | Run without the TUI for CI/automation: `flywheel --headless [--session <id>] [--one-shot] [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>] [--jsonl]` (JSONL Chat) or `flywheel --headless --acp [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>]` (Agent Client Protocol v1 Chat) or `flywheel --headless --task <text> [--system-prompt <text>] [--model <id\|tier>] [--effort <level>] [--disable-tool <name>]... [--auth-profile <profile>] [--auth-snapshot <absolute-path>] [--deadline-seconds <seconds>] [--jsonl]` (Direct Task) |
| `--task <text>` | Run one direct headless task through the shared production runner. |
| `--deadline-seconds <n>` | Positive finite deadline in seconds for --task. |
| `--system-prompt <text>` | Replace the full direct-task system prompt. The override is recorded in session request-audit history and is not secret input. |
| `--model <id>` | Run a direct headless task on this model instead of the configured chat role. |
| `--effort <level>` | Reasoning effort for --model. |
| `--disable-tool <name>` | Disable one active first-party tool for a headless chat or direct task. |
| `--auth-profile <profile>` | Select the auth profile for a headless chat or direct task. |
| `--session <id>` | Attach an existing headless chat without automatic Resume. |
| `--one-shot` | Return after durable handoff and owned work settle; plain parking is incomplete. |
| `--acp` | Speak Agent Client Protocol version 1 on standard input and output instead of the JSONL channel. |
| `--auth-snapshot <path>` | Consume a matching one-use auth snapshot from a trusted source. |
| `--jsonl` | Write versioned JSONL progress and terminal records. |
| `--allow-persistent-processes` | Allow tools to start processes that survive this invocation. |

## Examples

```text
flywheel events search --errors --latest
flywheel auth login --copilot
```

## Subcommands

Run `flywheel <subcommand> --help` for the details of one subcommand.

### `flywheel auth`

| Command | Description |
| --- | --- |
| `flywheel auth login` | Choose a model provider and sign in. |
| `flywheel auth login --<provider>` | Sign in to one provider, such as --copilot. |
| `flywheel auth login --provider <id>` | Sign in to a [custom_providers] entry. |
| `flywheel auth status` | Show the sign-in status of every provider. |
| `flywheel auth logout` | Choose a provider and remove its credentials. |
| `flywheel auth logout --<provider>` | Remove one provider's credentials. |
| `flywheel auth logout --provider <id>` | Remove a [custom_providers] entry's credentials. |

### `flywheel serve`

| Command | Description |
| --- | --- |
| `flywheel serve [install\|uninstall]` | Run or manage the account service. |

### `flywheel web`

| Command | Description |
| --- | --- |
| `flywheel web` | Open this project's sessions in the local browser. |

### `flywheel kill`

| Command | Description |
| --- | --- |
| `flywheel kill [--dry-run]` | Stop every Flywheel process on this machine. The hard reset, for a runtime nothing else will end. |

### `flywheel font`

| Command | Description |
| --- | --- |
| `flywheel font status` | Show the Monaspace Argon install status. |
| `flywheel font install` | Install the bundled Monaspace Argon font. |
| `flywheel font dismiss` | Hide the Flywheel font tip. |
| `flywheel font reset` | Show the Flywheel font tip again. |

### `flywheel events`

| Command | Description |
| --- | --- |
| `flywheel events search [pattern]` | Search this workspace's typed session facts. |
| `flywheel events evidence --session <id>` | Read durable execution evidence as JSON. |
| `flywheel events maintain` | Compact and maintain the workspace event store. |

### `flywheel update`

| Command | Description |
| --- | --- |
| `flywheel update` | Check for a newer Flywheel and install it. |

### `flywheel headless`

| Command | Description |
| --- | --- |
| `flywheel headless snapshot-auth --auth-profile <profile> --output <absolute-path>` | Export one auth profile as a one-use snapshot that a trusted headless run reads through --auth-snapshot. |

### `flywheel skills`

| Command | Description |
| --- | --- |
| `flywheel skills list` | List installed skills with load counts from durable facts. |
| `flywheel skills why <name>` | Trace a skill's loads and writes to sessions and requests. |
| `flywheel skills restore <name>` | Restore an archived learned skill. |
| `flywheel skills prune [--dry-run]` | Archive learned skills with no activity in the window. |
| `flywheel skills cleanup --force` | Run forced learned-skill corpus cleanup. |
| `flywheel skills maintain` | Survey or apply learned-skill maintenance. |
| `flywheel skills doctor` | Inspect learned skills and repair moved paths. |

### `flywheel memory`

| Command | Description |
| --- | --- |
| `flywheel memory show` | Print both memory stores with usage against their limits. |

### `flywheel mcp`

| Command | Description |
| --- | --- |
| `flywheel mcp add <name> [--local] ...` | Add an MCP server: --url `<url>` for remote servers, or -- `<executable>` [args...] for local stdio servers. |
| `flywheel mcp login <name> [--local]` | Authenticate a global or project-effective remote MCP server via OAuth. |
| `flywheel mcp status [--local]` | Show global or project-effective MCP servers and their state. |
| `flywheel mcp list [--local]` | List global or project-effective MCP servers. |
| `flywheel mcp remove <name> [--local]` | Confirm scoped removal and keep saved credentials. |
| `flywheel mcp import <path> [--local]` | Import servers into global or private project configuration. |

### `flywheel remote`

| Command | Description |
| --- | --- |
| `flywheel remote pair [--relay <url>]` | Show a code that pairs a phone with this machine. |
| `flywheel remote devices [revoke <id>]` | List paired phones, or revoke one. |
| `flywheel remote projects [forget <root>]` | List projects a phone can open, or forget one. |
| `flywheel remote status` | Show relay, paired device, and process initiation status. |
| `flywheel remote machines [add\|forget]` | List, pair with, or forget the machines this terminal opens projects on. |

### `flywheel workflow`

| Command | Description |
| --- | --- |
| `flywheel workflow reducers` | List the registered reducers a map join can name. |
| `flywheel workflow verify <file>` | Verify a workflow file compiles and is sound. With --workflow `<id>`, replay a workflow read-only. |
