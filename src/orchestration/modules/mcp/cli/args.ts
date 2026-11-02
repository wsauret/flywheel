interface McpAddSpec {
  readonly name: string
  readonly server:
    | { readonly url: string; readonly headers: StringDictionary; readonly oauth?: McpOAuthClientSpec }
    | { readonly command: string; readonly args: string[]; readonly env: StringDictionary }
  /** Ask for the OAuth client secret and keep it in the credential store. */
  readonly askClientSecret: boolean
}

interface McpOAuthClientSpec {
  readonly client_id?: string
  readonly callback_port?: number
}

interface StringDictionary {
  [key: string]: string
}

export type McpCliAction = (
  | { readonly kind: "login"; readonly name: string; readonly askClientSecret: boolean }
  | { readonly kind: "status" }
  | { readonly kind: "add"; readonly spec: McpAddSpec }
  | { readonly kind: "import"; readonly path: string }
  | { readonly kind: "remove"; readonly name: string }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }
) & { readonly local?: true }

export const MCP_USAGE = `Usage: flywheel mcp <command>

Commands:
  add <name> --url <url>              Add a remote (streamable HTTP) MCP server
  add <name> -- <command> [args...]   Add a local (stdio) MCP server
  login <name> [--client-secret]      Authenticate an HTTP MCP server (OAuth)
  status                              Show configured MCP server status
  import <path>                       Import servers from a .mcp.json file
  list                                Alias for status
  remove <name>                       Confirm removal; keep saved credentials

Scope:
  --local                 Use private choices for the current project on any command
                          Setup and removal are global by default

Options for add:
  --header "Name: value"   Add an HTTP header (repeatable; use \${VAR} for secrets)
  --env KEY=VALUE          Set an env var for a stdio server (repeatable)
  --client-id <id>         Use a pre-registered OAuth client (for servers without dynamic registration)
  --client-secret          Ask for the OAuth client secret (or read MCP_CLIENT_SECRET); also on login
  --callback-port <port>   Fixed OAuth callback port (for a registered redirect URL)

Examples:
  flywheel mcp add linear --url https://mcp.linear.app/mcp
  flywheel mcp login linear
  flywheel mcp add linear -- npx -y mcp-remote https://mcp.linear.app/mcp`

export function parseMcpArgs(args: readonly string[]): McpCliAction {
  const delimiter = args.indexOf("--")
  const optionEnd = delimiter < 0 ? args.length : delimiter
  const local = args.slice(1, optionEnd).includes("--local")
  if (local) {
    const parsed = parseMcpArgs(args.filter((arg, index) => index >= optionEnd || arg !== "--local"))
    return parsed.kind === "help" || parsed.kind === "error" ? parsed : { ...parsed, local: true }
  }
  const command = args[0]
  if (!command || command === "help" || command === "--help" || command === "-h") return { kind: "help" }
  if (command === "status" || command === "list") return args.length === 1 ? { kind: "status" } : { kind: "error", message: `mcp ${command} takes no arguments` }
  if (command === "remove") return args.length === 2 && args[1] && !args[1].startsWith("-") ? { kind: "remove", name: args[1] } : { kind: "error", message: "mcp remove requires exactly one server name" }
  if (command === "add") return parseAdd(args.slice(1))
  if (command === "login") {
    const flags = args.slice(1).filter((arg) => arg.startsWith("-"))
    const names = args.slice(1).filter((arg) => !arg.startsWith("-"))
    const unknown = flags.find((flag) => flag !== "--client-secret")
    if (unknown !== undefined) return { kind: "error", message: `Unknown mcp login option: ${unknown}` }
    const name = names[0]
    if (name === undefined || names.length !== 1) return { kind: "error", message: "mcp login requires exactly one server name" }
    return { kind: "login", name, askClientSecret: flags.length > 0 }
  }
  if (command === "import") {
    const value = args[1]
    if (!value || value.startsWith("-") || args.length !== 2) return { kind: "error", message: "mcp import requires exactly one path" }
    return { kind: "import", path: value }
  }
  return { kind: "error", message: `Unknown mcp command: ${command}` }
}

// Accepts both Flywheel's native shape and the common `mcp add` shape that MCP vendors
// publish, so a vendor's install command works with only the binary name swapped:
// flags may precede the name, --transport http and --scope <s> are tolerated, and the
// URL may be positional after the name.
function parseAdd(args: readonly string[]): McpCliAction {
  const positionals: string[] = []
  let url: string | undefined
  const headers: StringDictionary = {}
  const env: StringDictionary = {}
  let stdio: string[] | undefined
  let clientId: string | undefined
  let callbackPort: number | undefined
  let askClientSecret = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--") { stdio = args.slice(i + 1); break }
    if (!arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    if (arg === "--client-secret") { askClientSecret = true; continue }
    const value = args[i + 1]
    if (arg === "--client-id" || arg === "--callback-port") {
      if (value === undefined) return { kind: "error", message: `${arg} requires a value` }
      i += 1
      if (arg === "--client-id") { clientId = value; continue }
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { kind: "error", message: `--callback-port expects a port from 1 to 65535, got: ${value}` }
      callbackPort = port
      continue
    }
    if (arg === "--url" || arg === "--header" || arg === "--env" || arg === "--transport" || arg === "--scope") {
      if (value === undefined) return { kind: "error", message: `${arg} requires a value` }
      i += 1
      if (arg === "--scope") continue // Vendor compatibility; only --local selects project choices.
      if (arg === "--transport") {
        if (value === "http") continue // Vendor compatibility; streamable HTTP is the only remote transport
        return { kind: "error", message: `Unsupported transport: ${value} (only streamable HTTP is supported)` }
      }
      if (arg === "--url") { url = value; continue }
      if (arg === "--env") {
        const eq = value.indexOf("=")
        if (eq <= 0) return { kind: "error", message: `--env expects KEY=VALUE, got: ${value}` }
        env[value.slice(0, eq)] = value.slice(eq + 1)
        continue
      }
      const colon = value.indexOf(":")
      if (colon <= 0) return { kind: "error", message: `--header expects "Name: value", got: ${value}` }
      headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim()
      continue
    }
    return { kind: "error", message: `Unknown mcp add option: ${arg}` }
  }
  const [name, positionalUrl, ...extra] = positionals
  if (name === undefined) return { kind: "error", message: "mcp add requires a server name: flywheel mcp add <name> ..." }
  if (extra.length > 0) return { kind: "error", message: `Unexpected argument: ${extra[0]}` }
  if (positionalUrl !== undefined) {
    if (url !== undefined) return { kind: "error", message: "URL given twice (positional and --url)" }
    url = positionalUrl
  }
  if (url !== undefined && stdio !== undefined) return { kind: "error", message: "mcp add takes either a URL or -- <command>, not both" }
  if (askClientSecret && clientId === undefined) return { kind: "error", message: "--client-secret requires --client-id" }
  if (url !== undefined) {
    if (Object.keys(env).length > 0) return { kind: "error", message: "--env only applies to stdio servers; use --header for remote servers" }
    const oauth: McpOAuthClientSpec = {
      ...(clientId === undefined ? {} : { client_id: clientId }),
      ...(callbackPort === undefined ? {} : { callback_port: callbackPort }),
    }
    return { kind: "add", spec: { name, server: { url, headers, ...(Object.keys(oauth).length === 0 ? {} : { oauth }) }, askClientSecret } }
  }
  if (clientId !== undefined || callbackPort !== undefined) return { kind: "error", message: "--client-id and --callback-port only apply to remote servers" }
  const [stdioCommand, ...stdioArgs] = stdio ?? []
  if (stdioCommand === undefined) return { kind: "error", message: "mcp add requires a URL or -- <command> [args...]" }
  if (Object.keys(headers).length > 0) return { kind: "error", message: "--header only applies to remote servers; use --env for stdio servers" }
  return { kind: "add", spec: { name, server: { command: stdioCommand, args: stdioArgs, env }, askClientSecret } }
}
