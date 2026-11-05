import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redacted, Result, Schema } from "effect";
import { loadConfig } from "../../../../../src/orchestration/config/loader.js";
import { configSection } from "../../../../../src/orchestration/config/config-section.js";
import {
  McpServerConfigSchema,
  McpConfigSchema,
  resolveMcpConfig,
  mcpConfigSection,
  resolveMcpTemplate,
} from "../../../../../src/orchestration/modules/mcp/config.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

interface UnknownObject {
  [key: string]: unknown;
}

function decodes(value: unknown): boolean {
  return Result.isSuccess(Schema.decodeUnknownResult(McpServerConfigSchema)(value));
}

describe("MCP config", () => {
  it("reads old global TOML without rewriting it and refuses malformed project choices", () => {
    const directory = temporaryDirectory("flywheel-mcp-config-");
    const file = join(directory, "flywheel.toml");
    const old = '[mcp.servers.old]\ncommand = "bun"\nenabled = false\n';
    writeFileSync(file, old);
    const config = configSection(loadConfig(file).config, mcpConfigSection);
    expect(config.projects).toEqual({});
    expect(resolveMcpConfig(config, "/a").servers.old?.enabled).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(old);
    for (const [entry, message] of [
      ['enabled = true', "global MCP server"],
      ['enabled = "yes"', "enabled-only boolean"],
      ['enabled = true\nextra = 1', "enabled-only boolean"],
      ['enabled = true\nclient = "claude"', "enabled-only boolean"],
      ['command = "bun"\nurl = "https://example.test"', "exactly one MCP transport"],
    ]) {
      const source = `[mcp.projects."/a".servers.orphan]\n${entry}\n`;
      writeFileSync(file, source);
      expect(() => loadConfig(file)).toThrow(message);
      expect(readFileSync(file, "utf8")).toBe(source);
    }
  });

  it("resolves private project definitions and enabled overrides without merging connection fields", () => {
    const config = Schema.decodeUnknownSync(McpConfigSchema)({
      servers: { shared: { url: "https://global.test", headers: { "X-Account": "global" }, oauth: { client_id: "global" } }, off: { command: "old", args: ["serve"], env: { MODE: "global" }, enabled: false } },
      projects: { "/a": { servers: { shared: { url: "https://local.test" }, off: { enabled: true }, only: { command: "local" } } } },
    });
    const a = resolveMcpConfig(config, "/a");
    expect(a.servers.shared).toEqual({ url: "https://local.test", headers: {}, enabled: true });
    expect(a.servers.off).toEqual({ command: "old", args: ["serve"], env: { MODE: "global" }, enabled: true });
    expect(a.metadata.shared).toMatchObject({ definitionScope: "project", hasGlobalFallback: true });
    expect(a.metadata.off).toMatchObject({ definitionScope: "global", enabledScope: "project" });
    expect(resolveMcpConfig(config, "/b").servers.only).toBeUndefined();
    expect(resolveMcpConfig(config, "/b").servers.shared?.oauth?.client_id).toBe("global");
    const overridden = resolveMcpConfig({ ...config, projects: { "/a": { servers: { shared: { enabled: false } } } } }, "/a");
    expect(overridden.servers.shared).toEqual({ ...config.servers.shared!, enabled: false });
  });

  it("normalizes stdio and HTTP servers", () => {
    const stdio = Schema.decodeUnknownSync(McpServerConfigSchema)({ command: "bun" });
    const http = Schema.decodeUnknownSync(McpServerConfigSchema)({ url: "https://example.test/mcp" });
    expect(stdio).toEqual({ command: "bun", args: [], env: {}, enabled: true });
    expect(http).toEqual({ url: "https://example.test/mcp", headers: {}, enabled: true });
    const oauth = { client_id: "123.456", callback_port: 3118, scope: "search:read.public" };
    expect(Schema.decodeUnknownSync(McpServerConfigSchema)({ url: "https://example.test/mcp", oauth }))
      .toEqual({ url: "https://example.test/mcp", headers: {}, oauth, enabled: true });
  });

  it("preserves authored dictionary names and rejects inherited names as orphan overrides", () => {
    const file = join(temporaryDirectory("flywheel-mcp-config-"), "flywheel.toml");
    for (const name of ["__proto__", "toString", "constructor"]) {
      expect(Object.keys(resolveMcpConfig(Schema.decodeUnknownSync(McpConfigSchema)({}), name).servers)).toEqual([]);
      writeFileSync(file, `[mcp.projects."${name}".servers."${name}"]\ncommand = "local"\n`);
      const config = configSection(loadConfig(file).config, mcpConfigSection);
      const resolved = resolveMcpConfig(config, name);
      expect(Object.keys(resolved.servers)).toEqual([name]);
      expect(resolved.servers[name]).toMatchObject({ command: "local" });
      expect(Object.keys(resolved.metadata)).toEqual([name]);
      expect(resolved.metadata[name]).toMatchObject({ definitionScope: "project", hasGlobalFallback: false });
      expect(Object.keys(resolveMcpConfig(config, "/missing").servers)).toEqual([]);
      writeFileSync(file, `[mcp.servers."${name}"]\ncommand = "global"\n[mcp.projects."${name}".servers."${name}"]\nenabled = false\n`);
      expect(resolveMcpConfig(configSection(loadConfig(file).config, mcpConfigSection), name).servers[name])
        .toMatchObject({ command: "global", enabled: false });
      writeFileSync(file, `[mcp.servers.real]\ncommand = "global"\n[mcp.projects."/a".servers."${name}"]\nenabled = true\n`);
      expect(() => loadConfig(file)).toThrow("global MCP server");
    }
  });

  it("rejects missing, duplicate, and cross-transport fields", () => {
    expect(decodes({})).toBe(false);
    expect(decodes({ command: "bun", url: "https://example.test" })).toBe(false);
    expect(decodes({ command: "bun", headers: { Authorization: "x" } })).toBe(false);
    expect(decodes({ url: "https://example.test", args: ["serve"] })).toBe(false);
    expect(decodes({ command: "bun", oauth: { client_id: "client" } })).toBe(false);
    expect(decodes({ url: "https://example.test", oauth: { callback_port: 70000 } })).toBe(false);
    expect(decodes({ url: "https://example.test", client: "claude" })).toBe(true);
    expect(decodes({ url: "https://example.test", client: "other" })).toBe(false);
    expect(decodes({ command: "bun", client: "claude" })).toBe(false);
  });

  it("reports targeted loader errors", () => {
    expect(() => loadConfigFrom({ command: "bun", url: "https://example.test" })).toThrow("expected exactly one MCP transport");
    expect(() => loadConfigFrom({ command: "bun", headers: { Authorization: "x" } })).toThrow("stdio server");
    expect(() => loadConfigFrom({ url: "https://example.test", env: { TOKEN: "x" } })).toThrow("HTTP server");
  });

  it("resolves templates only against the supplied environment and redacts the value", () => {
    const value = resolveMcpTemplate(["Bearer $", "{TOKEN}"].join(""), { TOKEN: "secret" });
    expect(Redacted.value(value)).toBe("Bearer secret");
    expect(String(value)).not.toContain("secret");
    expect(() => resolveMcpTemplate(["$", "{MISSING}"].join(""), {})).toThrow("MISSING");
  });
});

function loadConfigFrom(server: UnknownObject): void {
  const directory = temporaryDirectory("flywheel-mcp-config-");
  const file = join(directory, "flywheel.toml");
  const fields = Object.entries(server).map(([key, value]) => `${key} = ${tomlValue(value)}`);
  writeFileSync(file, `[mcp.servers.test]\n${fields.join("\n")}\n`);
  loadConfig(file);
}

function tomlValue(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}
