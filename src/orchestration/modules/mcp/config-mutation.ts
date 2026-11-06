import { Schema } from "effect";
import { removeSemanticSubtree, upsertSemanticAssignment } from "../../config/config-assignment.js";
import type { ConfigMutationResult, RuntimeConfigOwner } from "../../config/runtime-config-owner.js";
import { resolveMcpClient } from "./clients.js";
import { isMcpEnabledOverride, mcpConfigSection, McpServerConfigSchema, type McpConfig, type McpConfiguredServers, type McpScope } from "./config.js";

type SemanticValue = null | string | number | boolean | readonly SemanticValue[] | { readonly [key: string]: SemanticValue | undefined };
type Environment = { readonly [K in string]: string | undefined };
type TomlValue = string | number | boolean | readonly TomlValue[] | { readonly [key: string]: TomlValue | undefined };

function ownEntry<T>(entries: { readonly [key: string]: T }, key: string): T | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}

function canonical(value: SemanticValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter((entry): entry is [string, SemanticValue] => entry[1] !== undefined).toSorted(([left], [right]) => compareCodePoints(left, right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function compareCodePoints(left: string, right: string): number {
  // SAFETY: String iteration yields nonempty Unicode code-point strings.
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  // SAFETY: String iteration yields nonempty Unicode code-point strings.
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    // SAFETY: The loop bounds index below both array lengths.
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Where a server's entries live: `servers` for a configured server, `connectors` for a claude.ai connector. */
type McpEntryKind = "servers" | "connectors";

/** Opaque selected-state expectation. Includes local choice and global fallback, not unrelated names or settings. */
export function mcpExpectedToken(config: McpConfig, projectRoot: string, name: string, kind: McpEntryKind = "servers"): string {
  const project = ownEntry(config.projects, projectRoot);
  return new Bun.CryptoHasher("sha256").update(canonical({ ...(kind === "connectors" ? { kind } : {}), global: ownEntry(config[kind], name) ?? null, project: project ? ownEntry(project[kind] ?? {}, name) ?? null : null })).digest("hex");
}

function pathFor(projectRoot: string, scope: McpScope, name: string, kind: McpEntryKind = "servers"): string[] {
  return scope === "global" ? ["mcp", kind, name] : ["mcp", "projects", projectRoot, kind, name];
}

function literal(value: TomlValue): string {
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  return `{ ${Object.entries(value).filter((entry): entry is [string, TomlValue] => entry[1] !== undefined).map(([key, item]) => `${JSON.stringify(key)} = ${literal(item)}`).join(", ")} }`;
}

export interface McpSelectedMutation {
  readonly projectRoot: string;
  readonly server: string;
  readonly scope: McpScope;
  readonly expected: string;
}

/** Set an authored definition or a private enabled override. A claude.ai connector, which claude.ai defines, keeps
 *  only its enabled choice. The fresh selected state is compared under account config ownership. */
export function setMcpEnabled(owner: Pick<RuntimeConfigOwner, "mutateSection">, request: McpSelectedMutation & { readonly enabled: boolean; readonly connector?: boolean }): Promise<ConfigMutationResult> {
  const kind: McpEntryKind = request.connector === true ? "connectors" : "servers";
  return owner.mutateSection(mcpConfigSection, request.expected,
    (config) => mcpExpectedToken(config, request.projectRoot, request.server, kind),
    (source, config) => {
      if (request.connector === true) return upsertSemanticAssignment(source, [...pathFor(request.projectRoot, request.scope, request.server, kind), "enabled"], literal(request.enabled));
      const project = ownEntry(config.projects, request.projectRoot);
      const local = project ? ownEntry(project.servers, request.server) : undefined;
      const global = ownEntry(config.servers, request.server);
      const selected = request.scope === "global" ? global : local ?? global;
      if (selected === undefined) throw new Error("MCP server no longer exists");
      return upsertSemanticAssignment(source, [...pathFor(request.projectRoot, request.scope, request.server), "enabled"], literal(request.enabled));
    });
}

/** Set the MCP client of an HTTP server in the scope that defines it. A choice equal to the client that the server
 *  gets without one is not stored, so the built-in list's reason shows and later list changes still apply. An
 *  enabled-only override and a stdio server have no client, so they refuse. */
export function setMcpClient(owner: Pick<RuntimeConfigOwner, "mutateSection">, request: McpSelectedMutation & { readonly client: "flywheel" | "claude" }, env: Environment): Promise<ConfigMutationResult> {
  return owner.mutateSection(mcpConfigSection, request.expected,
    (config) => mcpExpectedToken(config, request.projectRoot, request.server),
    (source, config) => {
      const project = ownEntry(config.projects, request.projectRoot);
      const selected = request.scope === "global" ? ownEntry(config.servers, request.server) : project ? ownEntry(project.servers, request.server) : undefined;
      if (selected === undefined || isMcpEnabledOverride(selected)) throw new Error("MCP definition no longer exists in this scope");
      if (selected.url === undefined) throw new Error("A stdio MCP server has no client choice");
      const path = [...pathFor(request.projectRoot, request.scope, request.server), "client"];
      const { client: _chosen, ...unchosen } = selected;
      return resolveMcpClient(unchosen, env)?.kind === request.client ? removeSemanticSubtree(source, path) : upsertSemanticAssignment(source, path, literal(request.client));
    });
}

/** Turn the account's claude.ai connectors on or off for every project. */
export function setMcpClaudeAiConnectors(owner: Pick<RuntimeConfigOwner, "mutateSection">, enabled: boolean): Promise<ConfigMutationResult> {
  return owner.mutateSection(mcpConfigSection, true, () => true, (source) => upsertSemanticAssignment(source, ["mcp", "claude_ai_connectors"], literal(enabled)));
}

/** Remove the stated authored entry. Global removal also removes dependent enabled-only overrides in the same publication. Credentials are untouched. */
export function removeMcpServer(owner: Pick<RuntimeConfigOwner, "mutateSection">, request: McpSelectedMutation): Promise<ConfigMutationResult> {
  return owner.mutateSection(mcpConfigSection, request.expected,
    (config) => mcpExpectedToken(config, request.projectRoot, request.server),
    (source, config) => {
      const project = ownEntry(config.projects, request.projectRoot);
      const selected = request.scope === "global" ? ownEntry(config.servers, request.server) : project ? ownEntry(project.servers, request.server) : undefined;
      if (selected === undefined) throw new Error("MCP definition no longer exists in this scope");
      let next = removeSemanticSubtree(source, pathFor(request.projectRoot, request.scope, request.server));
      if (request.scope === "global") for (const [root, choices] of Object.entries(config.projects)) {
        const entry = ownEntry(choices.servers, request.server);
        if (entry !== undefined && isMcpEnabledOverride(entry)) next = removeSemanticSubtree(next, pathFor(root, "project", request.server));
      }
      return next;
    });
}

/** Add definitions atomically, refusing same-scope duplicates. Project definitions can shadow global names. */
export function addMcpServers(owner: RuntimeConfigOwner, projectRoot: string, scope: McpScope, servers: McpConfiguredServers): Promise<ConfigMutationResult> {
  const names = Object.keys(servers).sort();
  const expected = names.map(() => false);
  const normalized = Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, Schema.decodeUnknownSync(McpServerConfigSchema, { onExcessProperty: "error" })(value)]));
  return owner.mutateSection(mcpConfigSection, expected,
    (config) => {
      const entries = scope === "global" ? config.servers : ownEntry(config.projects, projectRoot)?.servers;
      return names.map((name) => entries !== undefined && Object.hasOwn(entries, name));
    },
    (source) => Object.entries(normalized).reduce((next, [name, value]) => upsertSemanticAssignment(next, pathFor(projectRoot, scope, name), literal(value)), source));
}

/** Safe user guidance for saved, refused, and unknown publication outcomes. Raw errors remain inside the config authority. */
export function mcpMutationMessage(result: ConfigMutationResult): string | undefined {
  if (!result.ok) return result.kind === "write-outcome-unknown"
    ? "Saving could not be verified. Check MCP settings before trying again."
    : result.kind === "stale" ? "MCP settings changed. Review the current server and try again."
    : "MCP settings were not changed. Check the configuration and try again.";
  if (result.subscriberOutcome.kind === "committed-but-degraded") return result.durabilityWarning === undefined
    ? "MCP settings were saved, but connections could not fully update. Check their status."
    : "MCP settings were saved, but connections could not fully update and publication verification or durability could not be confirmed. Check their status.";
  if (result.durabilityWarning !== undefined) return "MCP settings were saved, but publication verification or durability could not be confirmed.";
  return undefined;
}
