import { Effect, Redacted, Schema } from "effect";
import type { ConfigOwnerIssue, ModuleConfigSection } from "../../config/config-section.js";

const defaultTrue = Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true)));
const defaultStrings = Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([])));
const defaultRecord = Schema.Record(Schema.String, Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})));

/** How long one server may take to start and list its tools, and how long a later tool list refresh may take. */
export const MCP_STARTUP_TIMEOUT_MS = 30_000;

const described = <S extends Schema.Top>(schema: S, description: string) => schema.pipe(Schema.annotate({ description }));

const McpStdioServerConfigSchema = Schema.Struct({
  command: described(Schema.NonEmptyString, "Command to start the MCP stdio server."),
  args: described(defaultStrings, "Arguments passed to the MCP stdio command."),
  env: described(defaultRecord.pipe(Schema.annotate({ sensitive: true })), "Environment variables passed to the MCP stdio command."),
  enabled: described(defaultTrue, "Enable this MCP server."),
  url: Schema.optionalKey(Schema.Never),
  headers: Schema.optionalKey(Schema.Never),
  oauth: Schema.optionalKey(Schema.Never),
  client: Schema.optionalKey(Schema.Never),
}).pipe(Schema.annotate({ description: "An MCP server started as a stdio subprocess." }));

const McpOAuthClientConfigSchema = Schema.Struct({
  client_id: Schema.optionalKey(described(
    Schema.NonEmptyString,
    "Client ID of an OAuth client registered with the server's authorization server. Set it when the server does not support dynamic client registration. `flywheel mcp add --client-secret` and `flywheel mcp login --client-secret` store the client secret in the credential store.",
  )),
  callback_port: Schema.optionalKey(described(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    "Fixed local port for the OAuth redirect `http://127.0.0.1:<port>/callback`. Set it when the registered client allows only a fixed redirect URL.",
  )),
  scope: Schema.optionalKey(described(
    Schema.NonEmptyString,
    "Space-separated OAuth scopes to request. Without it, every scope that the server advertises is requested.",
  )),
}).pipe(Schema.annotate({ description: "OAuth client settings for an MCP HTTP server." }));

const McpHttpServerConfigSchema = Schema.Struct({
  url: described(Schema.NonEmptyString, "URL of the MCP HTTP server."),
  headers: described(defaultRecord.pipe(Schema.annotate({ sensitive: true })), "HTTP headers sent to the MCP server."),
  oauth: Schema.optionalKey(McpOAuthClientConfigSchema),
  client: Schema.optionalKey(described(
    Schema.Literals(["flywheel", "claude"]),
    "The MCP client that connects to this server. `claude` connects through the Claude engine that ships with Flywheel, for a server that accepts only approved apps; the server's sign-in page then names Claude. Without it, Flywheel's built-in list decides, and every other server uses `flywheel`.",
  )),
  enabled: described(defaultTrue, "Enable this MCP server."),
  command: Schema.optionalKey(Schema.Never),
  args: Schema.optionalKey(Schema.Never),
  env: Schema.optionalKey(Schema.Never),
}).pipe(Schema.annotate({ description: "An MCP server reached over HTTP." }));

export const McpServerConfigSchema = Schema.Union([
  McpStdioServerConfigSchema,
  McpHttpServerConfigSchema,
]);

const McpEnabledOverrideSchema = Schema.Struct({
  enabled: described(Schema.Boolean, "Override only the global server's enabled state in this project."),
  command: Schema.optionalKey(Schema.Never),
  url: Schema.optionalKey(Schema.Never),
  args: Schema.optionalKey(Schema.Never),
  env: Schema.optionalKey(Schema.Never),
  headers: Schema.optionalKey(Schema.Never),
  oauth: Schema.optionalKey(Schema.Never),
  client: Schema.optionalKey(Schema.Never),
}).pipe(Schema.annotate({ description: "An enabled-only project override of a global MCP server." }));
const McpProjectServerSchema = Schema.Union([...McpServerConfigSchema.members, McpEnabledOverrideSchema]);
const McpConnectorChoiceSchema = Schema.Struct({
  enabled: described(Schema.Boolean, "Enable this claude.ai connector."),
}).pipe(Schema.annotate({ description: "The person's choice for one claude.ai connector, which claude.ai defines." }));
const McpConnectorChoicesSchema = Schema.Record(Schema.String, McpConnectorChoiceSchema).pipe(
  Schema.withDecodingDefaultTypeKey(Effect.succeed({})),
  Schema.annotate({ exampleKey: "claude_ai_Claude_Docs" }),
);
const McpProjectSchema = Schema.Struct({
  servers: described(Schema.Record(Schema.String, McpProjectServerSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed({})),
    Schema.annotate({ exampleKey: "local tool" }),
  ), "Private project MCP definitions and enabled-only global overrides."),
  connectors: Schema.optionalKey(described(McpConnectorChoicesSchema, "Enabled choices for claude.ai connectors in this project, keyed by connector server name.")),
});

export const McpConfigSchema = Schema.Struct({
  servers: described(Schema.Record(Schema.String, McpServerConfigSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed({})),
    Schema.annotate({ exampleKey: "local tool-3" }),
  ), "MCP servers keyed by user-defined name."),
  // Remove no earlier than 2027-04-06: existing account files omit project choices.
  projects: described(Schema.Record(Schema.String, McpProjectSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed({})),
    Schema.annotate({ exampleKey: "/workspace/project" }),
  ), "Account-private MCP choices keyed by canonical project root."),
  claude_ai_connectors: described(
    Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
    "Use claude.ai connectors: add the connectors of the Claude logins of the auth profile as MCP servers. Connector data goes to whichever model uses their tools.",
  ),
  connectors: described(McpConnectorChoicesSchema, "Enabled choices for claude.ai connectors in all projects, keyed by connector server name."),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({ servers: {}, projects: {}, claude_ai_connectors: false, connectors: {} })));

export type McpServerConfig = typeof McpServerConfigSchema.Type;
export type McpConfig = typeof McpConfigSchema.Type;
export type McpProjectServer = typeof McpProjectServerSchema.Type;
export type McpScope = "global" | "project";
export interface McpServerSource {
  readonly definitionScope: McpScope;
  readonly enabledScope: McpScope;
  readonly enabled: boolean;
  readonly hasGlobalFallback: boolean;
}
interface McpSourceRegistry { [name: string]: McpServerSource }
/** The servers that one manager connects, and the source of each. */
export interface McpRegistry {
  readonly servers: McpServerRegistry;
  readonly metadata: Readonly<McpSourceRegistry>;
}

export interface McpResolvedConfig {
  readonly servers: McpConfiguredServers;
  readonly metadata: Readonly<McpSourceRegistry>;
}

export function isMcpEnabledOverride(value: McpProjectServer): value is typeof McpEnabledOverrideSchema.Type {
  return value.command === undefined && value.url === undefined;
}

/** One claude.ai connector as the registry holds it: the key of the Claude login that serves it, and that login as a
 *  person reads it. */
export interface McpConnectorServer {
  readonly connector: { readonly login: string; readonly identity: string };
  readonly enabled: boolean;
}

/** One server of the published registry: a configured server, or a claude.ai connector that claude.ai defines. */
export type McpRegistryServer = McpServerConfig | McpConnectorServer;

export function isMcpConnector(server: McpRegistryServer): server is McpConnectorServer {
  return "connector" in server;
}

/** Add the read claude.ai connectors to a resolved config, each with the person's enabled choice: a project choice
 *  wins over an all-projects choice, and a connector is on without either. A configured server keeps its name. */
export function withMcpConnectors(resolved: McpResolvedConfig, config: McpConfig, projectRoot: string, connectors: { readonly [name: string]: McpConnectorServer["connector"] }): McpRegistry {
  const project = Object.hasOwn(config.projects, projectRoot) ? config.projects[projectRoot] : undefined;
  const added = Object.entries(connectors).filter(([name]) => !Object.hasOwn(resolved.servers, name)).map(([name, connector]) => {
    const local = project?.connectors !== undefined && Object.hasOwn(project.connectors, name) ? project.connectors[name] : undefined;
    const global = Object.hasOwn(config.connectors, name) ? config.connectors[name] : undefined;
    const enabled = local?.enabled ?? global?.enabled ?? true;
    const source: McpServerSource = { definitionScope: "global", enabledScope: local === undefined ? "global" : "project", enabled, hasGlobalFallback: false };
    return { name, server: { connector, enabled } satisfies McpConnectorServer, source };
  });
  return {
    servers: { ...resolved.servers, ...Object.fromEntries(added.map(({ name, server }) => [name, server])) },
    metadata: { ...resolved.metadata, ...Object.fromEntries(added.map(({ name, source }) => [name, source])) },
  };
}

/** Resolve the owner-validated account section for the startup-canonical project root. Full project definitions replace globals; overrides retain connection details. */
export function resolveMcpConfig(config: McpConfig, projectRoot: string): McpResolvedConfig {
  const servers = new Map(Object.entries(config.servers));
  const metadata = new Map<string, McpServerSource>(Object.entries(config.servers).map(([name, value]) => [name, {
    definitionScope: "global", enabledScope: "global", enabled: value.enabled, hasGlobalFallback: false,
  }]));
  const project = Object.hasOwn(config.projects, projectRoot) ? config.projects[projectRoot] : undefined;
  for (const [name, value] of Object.entries(project?.servers ?? {})) {
    if (isMcpEnabledOverride(value)) {
      // SAFETY: The section decoder rejects overrides without a global definition.
      const base = config.servers[name]!;
      servers.set(name, { ...base, enabled: value.enabled });
      metadata.set(name, { definitionScope: "global", enabledScope: "project", enabled: value.enabled, hasGlobalFallback: false });
    } else {
      servers.set(name, value);
      metadata.set(name, { definitionScope: "project", enabledScope: "project", enabled: value.enabled, hasGlobalFallback: Object.hasOwn(config.servers, name) });
    }
  }
  return { servers: Object.fromEntries(servers), metadata: Object.fromEntries(metadata) };
}

type Environment = { readonly [K in string]: string | undefined };
type RedactedMcpValue = string | number | boolean | bigint | symbol | null | undefined | object;

const TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveMcpTemplate(
  template: string,
  env: Environment,
  substitutions?: Redacted.Redacted<string>[],
): Redacted.Redacted<string> {
  return Redacted.make(template.replace(TEMPLATE, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) throw new Error(`MCP environment variable is not set: ${name}`);
    substitutions?.push(Redacted.make(value));
    return value;
  }));
}

export function redactMcpString(value: string, secrets: ReadonlyArray<Redacted.Redacted<string>>): string {
  let redacted = value;
  for (const secret of secrets) {
    const resolved = Redacted.value(secret);
    if (resolved.length > 0) redacted = redacted.replaceAll(resolved, "[REDACTED]");
  }
  return redacted;
}

export function redactMcpValue(value: unknown, secrets: ReadonlyArray<Redacted.Redacted<string>>): RedactedMcpValue {
  if (typeof value === "string") return redactMcpString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactMcpValue(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [redactMcpString(key, secrets), redactMcpValue(item, secrets)],
    ));
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") return value;
  if (value === null) return null;
  if (value === undefined) return undefined;
  return String(value);
}

export function redactMcpError(error: unknown, secrets: ReadonlyArray<Redacted.Redacted<string>>): Error {
  return new Error(redactMcpString(error instanceof Error ? error.message : String(error), secrets));
}

/** The configured MCP servers keyed by name; the config file owns membership. */
export type McpConfiguredServers = { readonly [K in string]: McpServerConfig };

/** The MCP servers that one manager connects, keyed by name: the config file owns the membership of configured
 *  servers, and claude.ai the membership of connectors. */
export type McpServerRegistry = { readonly [K in string]: McpRegistryServer };

/** The `[mcp]` section of `flywheel.toml`, owned by this module through its
 *  `config` contribution. A replacement of the section replaces the
 *  connections; the servers carry command lines, headers, and environment, so
 *  the section is secret and never enters the kernel config view. */
export const mcpConfigSection = {
  key: "mcp",
  schema: McpConfigSchema,
  owner: "MCP servers",
  applications: [{ mode: "replace-resource", path: [] }],
  protocolExposure: "secret",
  ownerIssues: mcpOwnerIssues,
} as const satisfies ModuleConfigSection<typeof McpConfigSchema>;

interface RawMcpServers { [name: string]: unknown }
interface McpIssueRegistry { readonly servers: RawMcpServers; readonly path: string[]; readonly project: boolean }

/** Owner diagnostics distinguish transport faults and orphan overrides that union-member errors cannot explain. */
function mcpOwnerIssues(raw: unknown): readonly ConfigOwnerIssue[] {
  const servers = isRecord(raw) && isRecord(raw.servers) ? raw.servers : undefined;
  const issues: ConfigOwnerIssue[] = [];
  const registries: McpIssueRegistry[] = [];
  if (servers) registries.push({ servers, path: ["mcp", "servers"], project: false });
  if (isRecord(raw) && isRecord(raw.projects)) for (const [root, project] of Object.entries(raw.projects)) {
    if (isRecord(project) && isRecord(project.servers)) registries.push({ servers: project.servers, path: ["mcp", "projects", root, "servers"], project: true });
  }
  for (const registry of registries) for (const [name, value] of Object.entries(registry.servers)) {
    if (!isRecord(value)) continue;
    const path = [...registry.path, name];
    const hasCommand = Object.hasOwn(value, "command");
    const hasUrl = Object.hasOwn(value, "url");
    if (registry.project && !hasCommand && !hasUrl) {
      if (Object.keys(value).length !== 1 || typeof value.enabled !== "boolean") issues.push({ path, message: "expected an enabled-only boolean MCP override; default: not applicable." });
      else if (servers === undefined || !Object.hasOwn(servers, name)) issues.push({ path, message: "expected a global MCP server for this enabled override; default: not applicable." });
    } else if (hasCommand === hasUrl) {
      issues.push({ path, message: "found table; expected exactly one MCP transport (command or url); default: not applicable." });
    } else if (hasCommand && (Object.hasOwn(value, "headers") || Object.hasOwn(value, "oauth") || Object.hasOwn(value, "client"))) {
      issues.push({ path, message: "found table; expected an MCP stdio server without url, headers, oauth, or client; default: not applicable." });
    } else if (hasUrl && (Object.hasOwn(value, "args") || Object.hasOwn(value, "env"))) {
      issues.push({ path, message: "found table; expected an MCP HTTP server without command, args, or env; default: not applicable." });
    }
  }
  return issues;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
