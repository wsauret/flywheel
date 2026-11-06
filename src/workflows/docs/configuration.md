# Flywheel configuration reference

This file is generated from the configuration schema. Run `bun run docs:generate` to update it.

## `acknowledged_release_version`

### `acknowledged_release_version`

- Type: `string`
- Default: unset
- Application: `live`. Applies to the running interface immediately.

Flywheel writes the release last dismissed in the welcome notice. Users must not set this key.

```toml
# acknowledged_release_version is written by Flywheel at runtime.
```

## `allow_persistent_processes`

### `allow_persistent_processes`

- Type: `boolean`
- Default: `false`
- Application: `next-request`. Applies when the next provider request captures configuration.
- Application: `use-time-revalidate`. Revalidates from disk when the protected operation starts.

Let selected processes outlive Flywheel; you must stop them.

```toml
allow_persistent_processes = false
```

## `auth`

### `auth.project_profiles."*"`

- Type: `string`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Auth profiles keyed by canonical project root.

```toml
[auth.project_profiles]
"/workspace/project" = "example"
```

## `auto_delete_session_days`

### `auto_delete_session_days`

- Type: `number`
- Constraints: integer, at least 0
- Default: `0`
- Application: `live`. Applies to the running interface immediately.

Permanently delete chats after N inactive days. 0 turns it off.

```toml
auto_delete_session_days = 0
```

## `budget`

### `budget.max_invocations`

- Type: `number`
- Constraints: integer, at least 0
- Default: `0`
- Application: `next-request`. Applies when the next provider request captures configuration.

Maximum attempts that a workflow can start. Flywheel checks it before each attempt; a running agent always finishes.

```toml
[budget]
max_tokens = 0
max_wall_clock_minutes = 0
max_invocations = 0
```

### `budget.max_tokens`

- Type: `number`
- Constraints: integer, at least 0
- Default: `0`
- Application: `next-request`. Applies when the next provider request captures configuration.

Maximum tokens that a workflow can use. Flywheel checks it before each attempt; a running agent always finishes.

```toml
[budget]
max_invocations = 0
max_wall_clock_minutes = 0
max_tokens = 0
```

### `budget.max_wall_clock_minutes`

- Type: `number`
- Constraints: integer, at least 0
- Default: `0`
- Application: `next-request`. Applies when the next provider request captures configuration.

Maximum workflow wall-clock minutes, counted from the workflow launch. Flywheel checks it before each attempt; a running agent always finishes.

```toml
[budget]
max_invocations = 0
max_tokens = 0
max_wall_clock_minutes = 0
```

## `cache_retention`

### `cache_retention."*"`

- Type: `string`
- Allowed values: `"provider"`, `"5m"`, `"1h"`, `"in_memory"`, `"24h"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Prompt-cache retention keyed by API provider id. Omitted entries preserve existing defaults; provider selects the provider-managed policy.

```toml
[cache_retention]
openai_api = "provider"
```

## `compatible_rendering`

### `compatible_rendering`

- Type: `string`
- Constraints: "auto" or "on" or "off" or null
- Default: `"auto"`
- Application: `live`. Applies to the running interface immediately.

Connect borders in Terminal.app; Auto detects the terminal.

```toml
compatible_rendering = "auto"
```

## `custom_providers`

### `custom_providers."*".base_url`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Base URL of the custom provider.

```toml
[custom_providers.acme]
models = []
base_url = "example"
```

### `custom_providers."*".catalog_id`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Catalog id used for model metadata.

```toml
[custom_providers.acme]
base_url = "example"
models = []
catalog_id = "example"
```

### `custom_providers."*".context_limit`

- Type: `number`
- Constraints: integer, at least 1
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Context token limit for this provider.

```toml
[custom_providers.acme]
base_url = "example"
models = []
context_limit = 1
```

### `custom_providers."*".display_name`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Display name of the custom provider.

```toml
[custom_providers.acme]
base_url = "example"
models = []
display_name = "example"
```

### `custom_providers."*".models`

- Type: `array`
- Constraints: list of non-empty strings
- Default: `[]`
- Application: `replace-resource`. Applies after the replacement resource is ready.

Model ids served by the custom provider.

```toml
[custom_providers.acme]
base_url = "example"
models = []
```

## `diff_colors`

### `diff_colors`

- Type: `string`
- Allowed values: `"theme"`, `"standard"`
- Default: `"theme"`
- Application: `live`. Applies to the running interface immediately.

Theme tints, or the standard green and red every diff tool uses.

```toml
diff_colors = "theme"
```

## `disabled_modules`

### `disabled_modules`

- Type: `array`
- Constraints: list of strings
- Default: `[]`
- Application: `next-request`. Applies when the next provider request captures configuration.
- Application: `use-time-revalidate`. Revalidates from disk when the protected operation starts.

Disable Flywheel modules by canonical module id. Every module is on unless this list names it.

```toml
disabled_modules = []
```

## `font_tip_dismissed`

### `font_tip_dismissed`

- Type: `boolean`
- Default: `false`
- Application: `live`. Applies to the running interface immediately.

Flywheel writes whether the font tip was dismissed. Users must not set this key.

```toml
# font_tip_dismissed is written by Flywheel at runtime.
```

## `foreground_bash_hold_seconds`

### `foreground_bash_hold_seconds`

- Type: `number`
- Constraints: integer, 1 to 2147483
- Default: `240`
- Application: `next-request`. Applies when the next provider request captures configuration.

Maximum seconds a foreground Bash command can hold the tool call before it transfers to managed execution.

```toml
foreground_bash_hold_seconds = 240
```

## `idle_compaction`

### `idle_compaction`

- Type: `boolean`
- Default: `true`
- Application: `live`. Applies to the running interface immediately.
- Application: `use-time-revalidate`. Revalidates from disk when the protected operation starts.

Save notes and reset large idle chats before cache expiry.

```toml
idle_compaction = true
```

## `keybindings`

### `keybindings."*"`

- Type: `string`
- Default: unset
- Application: `live`. Applies to the running interface immediately.

Key chords of TUI commands keyed by command id, such as help = "ctrl+g". keys.md lists the command ids.

```toml
[keybindings]
help = "ctrl+g"
```

## `mcp`

### `mcp.claude_ai_connectors`

- Type: `boolean`
- Default: `false`
- Application: `replace-resource`. Applies after the replacement resource is ready.

Use claude.ai connectors: add the connectors of the Claude logins of the auth profile as MCP servers. Connector data goes to whichever model uses their tools.

```toml
[mcp]
claude_ai_connectors = false

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true
```

### `mcp.connectors."*".enabled`

- Type: `boolean`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Enable this claude.ai connector.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true
```

### `mcp.projects."*".connectors."*".enabled`

- Type: `boolean`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.

Enable this claude.ai connector.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true
```

### `mcp.projects."*".servers."*".args`

- Type: `array`
- Constraints: list of strings
- Default: `[]`
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Arguments passed to the MCP stdio command.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-1"]
command = "example"
enabled = true
args = []

[mcp.projects."/workspace/project".servers."local tool-1".env]
example = "example"
```

### `mcp.projects."*".servers."*".client`

- Type: `string`
- Allowed values: `"flywheel"`, `"claude"`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

The MCP client that connects to this server. `claude` connects through the Claude engine that ships with Flywheel, for a server that accepts only approved apps; the server's sign-in page then names Claude. Without it, Flywheel's built-in list decides, and every other server uses `flywheel`.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
url = "example"
enabled = true
client = "flywheel"

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"
```

### `mcp.projects."*".servers."*".command`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Command to start the MCP stdio server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-1"]
args = []
enabled = true
command = "example"

[mcp.projects."/workspace/project".servers."local tool-1".env]
example = "example"
```

### `mcp.projects."*".servers."*".enabled`

- Type: `boolean`
- Default: `true`
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Enable this MCP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
url = "example"
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"
```

### `mcp.projects."*".servers."*".enabled`

- Type: `boolean`
- Default: `true`
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Enable this MCP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-1"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool-1".env]
example = "example"
```

### `mcp.projects."*".servers."*".enabled`

- Type: `boolean`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An enabled-only project override of a global MCP server.

Override only the global server's enabled state in this project.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-3"]
enabled = true
```

### `mcp.projects."*".servers."*".env."*"`

- Type: `string`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Environment variables passed to the MCP stdio command.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-1"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool-1".env]
example = "example"
```

### `mcp.projects."*".servers."*".headers."*"`

- Type: `string`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

HTTP headers sent to the MCP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
url = "example"
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"
```

### `mcp.projects."*".servers."*".oauth.callback_port`

- Type: `number`
- Constraints: integer, 1 to 65535
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Fixed local port for the OAuth redirect `http://127.0.0.1:<port>/callback`. Set it when the registered client allows only a fixed redirect URL.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
url = "example"
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"

[mcp.projects."/workspace/project".servers."local tool-2".oauth]
callback_port = 1
```

### `mcp.projects."*".servers."*".oauth.client_id`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Client ID of an OAuth client registered with the server's authorization server. Set it when the server does not support dynamic client registration. `flywheel mcp add --client-secret` and `flywheel mcp login --client-secret` store the client secret in the credential store.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
url = "example"
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"

[mcp.projects."/workspace/project".servers."local tool-2".oauth]
client_id = "example"
```

### `mcp.projects."*".servers."*".oauth.scope`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Space-separated OAuth scopes to request. Without it, every scope that the server advertises is requested.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
url = "example"
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"

[mcp.projects."/workspace/project".servers."local tool-2".oauth]
scope = "example"
```

### `mcp.projects."*".servers."*".url`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

URL of the MCP HTTP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.servers."local tool-3"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3".env]
example = "example"

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.projects."/workspace/project".servers."local tool-2"]
enabled = true
url = "example"

[mcp.projects."/workspace/project".servers."local tool-2".headers]
example = "example"
```

### `mcp.servers."*".args`

- Type: `array`
- Constraints: list of strings
- Default: `[]`
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Arguments passed to the MCP stdio command.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-1"]
command = "example"
enabled = true
args = []

[mcp.servers."local tool-3-1".env]
example = "example"
```

### `mcp.servers."*".client`

- Type: `string`
- Allowed values: `"flywheel"`, `"claude"`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

The MCP client that connects to this server. `claude` connects through the Claude engine that ships with Flywheel, for a server that accepts only approved apps; the server's sign-in page then names Claude. Without it, Flywheel's built-in list decides, and every other server uses `flywheel`.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
url = "example"
enabled = true
client = "flywheel"

[mcp.servers."local tool-3-2".headers]
example = "example"
```

### `mcp.servers."*".command`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Command to start the MCP stdio server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-1"]
args = []
enabled = true
command = "example"

[mcp.servers."local tool-3-1".env]
example = "example"
```

### `mcp.servers."*".enabled`

- Type: `boolean`
- Default: `true`
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Enable this MCP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
url = "example"
enabled = true

[mcp.servers."local tool-3-2".headers]
example = "example"
```

### `mcp.servers."*".enabled`

- Type: `boolean`
- Default: `true`
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Enable this MCP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-1"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3-1".env]
example = "example"
```

### `mcp.servers."*".env."*"`

- Type: `string`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server started as a stdio subprocess.

Environment variables passed to the MCP stdio command.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-1"]
command = "example"
args = []
enabled = true

[mcp.servers."local tool-3-1".env]
example = "example"
```

### `mcp.servers."*".headers."*"`

- Type: `string`
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

HTTP headers sent to the MCP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
url = "example"
enabled = true

[mcp.servers."local tool-3-2".headers]
example = "example"
```

### `mcp.servers."*".oauth.callback_port`

- Type: `number`
- Constraints: integer, 1 to 65535
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Fixed local port for the OAuth redirect `http://127.0.0.1:<port>/callback`. Set it when the registered client allows only a fixed redirect URL.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
url = "example"
enabled = true

[mcp.servers."local tool-3-2".headers]
example = "example"

[mcp.servers."local tool-3-2".oauth]
callback_port = 1
```

### `mcp.servers."*".oauth.client_id`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Client ID of an OAuth client registered with the server's authorization server. Set it when the server does not support dynamic client registration. `flywheel mcp add --client-secret` and `flywheel mcp login --client-secret` store the client secret in the credential store.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
url = "example"
enabled = true

[mcp.servers."local tool-3-2".headers]
example = "example"

[mcp.servers."local tool-3-2".oauth]
client_id = "example"
```

### `mcp.servers."*".oauth.scope`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

Space-separated OAuth scopes to request. Without it, every scope that the server advertises is requested.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
url = "example"
enabled = true

[mcp.servers."local tool-3-2".headers]
example = "example"

[mcp.servers."local tool-3-2".oauth]
scope = "example"
```

### `mcp.servers."*".url`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `replace-resource`. Applies after the replacement resource is ready.
- Branch: An MCP server reached over HTTP.

URL of the MCP HTTP server.

```toml
[mcp]
claude_ai_connectors = true

[mcp.projects."/workspace/project".servers."local tool"]
command = "example"
args = []
enabled = true

[mcp.projects."/workspace/project".servers."local tool".env]
example = "example"

[mcp.projects."/workspace/project".connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.connectors.claude_ai_Claude_Docs]
enabled = true

[mcp.servers."local tool-3-2"]
enabled = true
url = "example"

[mcp.servers."local tool-3-2".headers]
example = "example"
```

## `memory`

### `memory.review_interval_turns`

- Type: `number`
- Constraints: integer, at least 0
- Default: `10`
- Application: `next-request`. Applies when the next provider request captures configuration.

Turns between memory reviews.

```toml
[memory]
review_interval_turns = 10
```

## `notifications`

### `notifications.desktop`

- Type: `boolean`
- Default: `true`
- Application: `live`. Applies to the running interface immediately.

Show a desktop notification when a session asks you a question.

```toml
[notifications]
desktop = true
```

## `proactive_compaction_threshold`

### `proactive_compaction_threshold`

- Type: `number`
- Constraints: 0 or integer, at least 50000
- Default: `270000`
- Application: `next-request`. Applies when the next provider request captures configuration.

Compact after this many context tokens. 0 turns it off.

```toml
proactive_compaction_threshold = 270000
```

## `profiles`

### `profiles."*".allow_training_routes`

- Type: `boolean`
- Default: `false`
- Application: `next-request`. Applies when the next provider request captures configuration.

Allow model routes that may use requests for training for this profile.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.roles."review role"]
model = "example"
effort = "low"

[profiles.work.roles."review role".provider_options.openai]
parallel_tool_calls = true
text_verbosity = "low"
reasoning_summary = "auto"
speed = "fast"
service_tier = "example"

[profiles.work.roles."review role".provider_options.openai.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.anthropic]
thinking_display = "updates"
user_id = "example"
speed = "fast"

[profiles.work.roles."review role".provider_options.anthropic.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.google]
temperature = 0

[profiles.work.roles."review role".provider_options.google.thinking_budgets]
low = 0
medium = 0
high = 0

[profiles.work.roles."review role".provider_options.google.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.openrouter]
allow_fallbacks = true
require_parameters = true
zdr = true
enforce_distillable_text = true
data_collection = "deny"
order = []
only = []
ignore = []
quantizations = []
sort = "example"
preferred_min_throughput = 1
preferred_max_latency = 1

[profiles.work.roles."review role".provider_options.openrouter.max_price]
prompt = 1
completion = 1
image = 1
audio = 1
request = 1

[profiles.work.providers."provider id"]
example = 0
```

### `profiles."*".git_ai_attribution`

- Type: `boolean`
- Default: `false`
- Application: `next-request`. Applies when the next provider request captures configuration.

Add AI attribution to Git commits created for this profile.

```toml
[profiles.work]
allow_training_routes = true
git_ai_attribution = true

[profiles.work.roles."review role"]
model = "example"
effort = "low"

[profiles.work.roles."review role".provider_options.openai]
parallel_tool_calls = true
text_verbosity = "low"
reasoning_summary = "auto"
speed = "fast"
service_tier = "example"

[profiles.work.roles."review role".provider_options.openai.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.anthropic]
thinking_display = "updates"
user_id = "example"
speed = "fast"

[profiles.work.roles."review role".provider_options.anthropic.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.google]
temperature = 0

[profiles.work.roles."review role".provider_options.google.thinking_budgets]
low = 0
medium = 0
high = 0

[profiles.work.roles."review role".provider_options.google.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.openrouter]
allow_fallbacks = true
require_parameters = true
zdr = true
enforce_distillable_text = true
data_collection = "deny"
order = []
only = []
ignore = []
quantizations = []
sort = "example"
preferred_min_throughput = 1
preferred_max_latency = 1

[profiles.work.roles."review role".provider_options.openrouter.max_price]
prompt = 1
completion = 1
image = 1
audio = 1
request = 1

[profiles.work.providers."provider id"]
example = 0
```

### `profiles."*".providers."*"."*"`

- Type: `number`
- Constraints: integer, at least 0 or 0
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Numeric settings the provider module declares, keyed by setting.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.roles."review role"]
model = "example"
effort = "low"

[profiles.work.roles."review role".provider_options.openai]
parallel_tool_calls = true
text_verbosity = "low"
reasoning_summary = "auto"
speed = "fast"
service_tier = "example"

[profiles.work.roles."review role".provider_options.openai.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.anthropic]
thinking_display = "updates"
user_id = "example"
speed = "fast"

[profiles.work.roles."review role".provider_options.anthropic.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.google]
temperature = 0

[profiles.work.roles."review role".provider_options.google.thinking_budgets]
low = 0
medium = 0
high = 0

[profiles.work.roles."review role".provider_options.google.extra_body]
example = "value"

[profiles.work.roles."review role".provider_options.openrouter]
allow_fallbacks = true
require_parameters = true
zdr = true
enforce_distillable_text = true
data_collection = "deny"
order = []
only = []
ignore = []
quantizations = []
sort = "example"
preferred_min_throughput = 1
preferred_max_latency = 1

[profiles.work.roles."review role".provider_options.openrouter.max_price]
prompt = 1
completion = 1
image = 1
audio = 1
request = 1

[profiles.work.providers."provider id"]
example = 0
```

### `profiles."*".roles."*".effort`

- Type: `string`
- Allowed values: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Select the reasoning effort for this role.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role"]
effort = "low"
```

### `profiles."*".roles."*".model`

- Type: `string`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Select the model id for this role.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role"]
model = "example"
```

### `profiles."*".roles."*".provider_options.anthropic.extra_body."*"`

- Type: `unknown`
- Shape: open record
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Add arbitrary provider request body fields.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.anthropic.extra_body]
example = "value"
```

### `profiles."*".roles."*".provider_options.anthropic.speed`

- Type: `string`
- Allowed values: `"fast"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Use the provider fast request mode.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.anthropic]
speed = "fast"
```

### `profiles."*".roles."*".provider_options.anthropic.thinking_display`

- Type: `string`
- Allowed values: `"updates"`, `"summarized"`, `"omitted"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set how thinking content is displayed.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.anthropic]
thinking_display = "updates"
```

### `profiles."*".roles."*".provider_options.anthropic.user_id`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the stable end-user abuse-tracking identifier.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.anthropic]
user_id = "example"
```

### `profiles."*".roles."*".provider_options.google.extra_body."*"`

- Type: `unknown`
- Shape: open record
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Add arbitrary provider request body fields.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.google.extra_body]
example = "value"
```

### `profiles."*".roles."*".provider_options.google.temperature`

- Type: `number`
- Constraints: number, 0 to 2
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the response sampling temperature.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.google]
temperature = 0
```

### `profiles."*".roles."*".provider_options.google.thinking_budgets.high`

- Type: `number`
- Constraints: integer, at least 0
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the high-effort thinking token budget.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.google.thinking_budgets]
high = 0
```

### `profiles."*".roles."*".provider_options.google.thinking_budgets.low`

- Type: `number`
- Constraints: integer, at least 0
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the low-effort thinking token budget.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.google.thinking_budgets]
low = 0
```

### `profiles."*".roles."*".provider_options.google.thinking_budgets.medium`

- Type: `number`
- Constraints: integer, at least 0
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the medium-effort thinking token budget.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.google.thinking_budgets]
medium = 0
```

### `profiles."*".roles."*".provider_options.openai.extra_body."*"`

- Type: `unknown`
- Shape: open record
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Add arbitrary provider request body fields.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openai.extra_body]
example = "value"
```

### `profiles."*".roles."*".provider_options.openai.parallel_tool_calls`

- Type: `boolean`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Allow parallel tool calls.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openai]
parallel_tool_calls = true
```

### `profiles."*".roles."*".provider_options.openai.reasoning_summary`

- Type: `string`
- Allowed values: `"auto"`, `"concise"`, `"detailed"`, `"off"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set reasoning summary detail.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openai]
reasoning_summary = "auto"
```

### `profiles."*".roles."*".provider_options.openai.service_tier`

- Type: `string`
- Constraints: non-empty string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the OpenAI service tier.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openai]
service_tier = "example"
```

### `profiles."*".roles."*".provider_options.openai.speed`

- Type: `string`
- Allowed values: `"fast"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Use the provider fast request mode.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openai]
speed = "fast"
```

### `profiles."*".roles."*".provider_options.openai.text_verbosity`

- Type: `string`
- Allowed values: `"low"`, `"medium"`, `"high"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set response text verbosity.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openai]
text_verbosity = "low"
```

### `profiles."*".roles."*".provider_options.openrouter.allow_fallbacks`

- Type: `boolean`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Allow fallback models.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
allow_fallbacks = true
```

### `profiles."*".roles."*".provider_options.openrouter.data_collection`

- Type: `string`
- Allowed values: `"deny"`, `"allow"`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the data collection policy.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
data_collection = "deny"
```

### `profiles."*".roles."*".provider_options.openrouter.enforce_distillable_text`

- Type: `boolean`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Require distillable text outputs.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
enforce_distillable_text = true
```

### `profiles."*".roles."*".provider_options.openrouter.ignore`

- Type: `array`
- Constraints: list of strings
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Exclude these providers from routing.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
ignore = []
```

### `profiles."*".roles."*".provider_options.openrouter.max_price.audio`

- Type: `number | string`
- Constraints: number or string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the maximum audio price.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter.max_price]
audio = 1
```

### `profiles."*".roles."*".provider_options.openrouter.max_price.completion`

- Type: `number | string`
- Constraints: number or string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the maximum completion price.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter.max_price]
completion = 1
```

### `profiles."*".roles."*".provider_options.openrouter.max_price.image`

- Type: `number | string`
- Constraints: number or string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the maximum image price.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter.max_price]
image = 1
```

### `profiles."*".roles."*".provider_options.openrouter.max_price.prompt`

- Type: `number | string`
- Constraints: number or string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the maximum prompt price.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter.max_price]
prompt = 1
```

### `profiles."*".roles."*".provider_options.openrouter.max_price.request`

- Type: `number | string`
- Constraints: number or string
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the maximum request price.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter.max_price]
request = 1
```

### `profiles."*".roles."*".provider_options.openrouter.only`

- Type: `array`
- Constraints: list of strings
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Restrict routing to these providers.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
only = []
```

### `profiles."*".roles."*".provider_options.openrouter.order`

- Type: `array`
- Constraints: list of strings
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set preferred provider order.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
order = []
```

### `profiles."*".roles."*".provider_options.openrouter.preferred_max_latency`

- Type: `number | table`
- Constraints: number or table with keys: p50, p75, p90, p99
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set preferred maximum latency.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
preferred_max_latency = 1
```

### `profiles."*".roles."*".provider_options.openrouter.preferred_min_throughput`

- Type: `number | table`
- Constraints: number or table with keys: p50, p75, p90, p99
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set preferred minimum throughput.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
preferred_min_throughput = 1
```

### `profiles."*".roles."*".provider_options.openrouter.quantizations`

- Type: `array`
- Constraints: list of strings
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Restrict routing to these quantizations.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
quantizations = []
```

### `profiles."*".roles."*".provider_options.openrouter.require_parameters`

- Type: `boolean`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Require models to support all request parameters.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
require_parameters = true
```

### `profiles."*".roles."*".provider_options.openrouter.sort`

- Type: `string | table`
- Constraints: string or table with keys: by, partition
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Set the provider routing sort.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
sort = "example"
```

### `profiles."*".roles."*".provider_options.openrouter.zdr`

- Type: `boolean`
- Default: unset
- Application: `next-request`. Applies when the next provider request captures configuration.

Require zero-data-retention endpoints.

```toml
[profiles.work]
git_ai_attribution = true
allow_training_routes = true

[profiles.work.providers."provider id"]
example = 0

[profiles.work.roles."review role".provider_options.openrouter]
zdr = true
```

## `projects`

### `projects."*".show_build`

- Type: `boolean`
- Default: `false`
- Application: `live`. Applies to the running interface immediately.

Show the build on this project's cards.

```toml
[projects."/workspace/project"]
show_build = true
```

## `remote`

### `remote.keep_awake`

- Type: `boolean`
- Default: `true`
- Application: `next-use`. Applies the next time Flywheel reads this setting.

Keep this machine awake while a phone uses a runtime it started?

```toml
[remote]
keep_awake = true
```

## `require_workflow_confirmation`

### `require_workflow_confirmation`

- Type: `boolean`
- Default: `false`
- Application: `use-time-revalidate`. Revalidates from disk when the protected operation starts.

Require confirmation before a workflow starts.

```toml
require_workflow_confirmation = false
```

## `show_thinking`

### `show_thinking`

- Type: `boolean`
- Default: `false`
- Application: `live`. Applies to the running interface immediately.

Show the model's thinking as text in the transcript.

```toml
show_thinking = false
```

## `skills`

### `skills.archive_after_days`

- Type: `number`
- Constraints: integer, at least 0
- Default: `90`
- Application: `next-use`. Applies the next time Flywheel reads this setting.

Days before a stale managed skill is archived.

```toml
[skills]
notifications = "off"
review_interval_iterations = 0
stale_after_days = 0
archive_after_days = 90
```

### `skills.notifications`

- Type: `string`
- Allowed values: `"off"`, `"on"`, `"verbose"`
- Default: `"on"`
- Application: `next-request`. Applies when the next provider request captures configuration.

Set managed-skill notification detail.

```toml
[skills]
review_interval_iterations = 0
stale_after_days = 0
archive_after_days = 0
notifications = "on"
```

### `skills.review_interval_iterations`

- Type: `number`
- Constraints: integer, at least 0
- Default: `10`
- Application: `next-request`. Applies when the next provider request captures configuration.

Iterations between managed-skill reviews.

```toml
[skills]
notifications = "off"
stale_after_days = 0
archive_after_days = 0
review_interval_iterations = 10
```

### `skills.stale_after_days`

- Type: `number`
- Constraints: integer, at least 0
- Default: `30`
- Application: `next-use`. Applies the next time Flywheel reads this setting.

Days before a managed skill becomes stale.

```toml
[skills]
notifications = "off"
review_interval_iterations = 0
archive_after_days = 0
stale_after_days = 30
```

## `subscription_usage`

### `subscription_usage.alert_thresholds`

- Type: `array`
- Constraints: list of integer, 1 to 100 values
- Default: `[70,90,100]`
- Application: `live`. Applies to the running interface immediately.

Ascending usage percentages for alerts. Empty disables alerts.

```toml
[subscription_usage]
alert_thresholds = [70, 90, 100]
```

## `tabs_hint_dismissed`

### `tabs_hint_dismissed`

- Type: `boolean`
- Default: `false`
- Application: `live`. Applies to the running interface immediately.

Flywheel writes whether the tabs hint was dismissed. Users must not set this key.

```toml
# tabs_hint_dismissed is written by Flywheel at runtime.
```

## `theme`

### `theme`

- Type: `string`
- Default: unset
- Application: `live`. Applies to the running interface immediately.

Choose the interface color theme.

```toml
theme = "example"
```

## `updates`

### `updates.auto_install`

- Type: `boolean`
- Default: `true`
- Application: `live`. Applies to the running interface immediately.
- Application: `use-time-revalidate`. Revalidates from disk when the protected operation starts.

Install new Flywheel releases automatically.

```toml
[updates]
auto_install = true
```

## `web_search`

### `web_search.provider`

- Type: `string`
- Allowed values: `"chatgpt"`, `"exa"`
- Default: `"chatgpt"`
- Application: `next-request`. Applies when the next provider request captures configuration.

The first web retrieval provider Flywheel tries.

```toml
[web_search]
provider = "chatgpt"
```

## `workflow`

### `workflow.max_attempts`

- Type: `number`
- Constraints: integer, 1 to 1000
- Default: `50`
- Application: `next-request`. Applies when the next provider request captures configuration.

The most attempts that one workflow run can make, when its file declares no guardrails.max_attempts.

```toml
[workflow]
max_attempts = 50
```

## `write_syntax_theme`

### `write_syntax_theme`

- Type: `string`
- Allowed values: `"nord"`, `"slate"`, `"vesper"`
- Default: `"nord"`
- Application: `live`. Applies to the running interface immediately.

Write tool colors only. Chat Markdown keeps the interface theme.

```toml
write_syntax_theme = "nord"
```
