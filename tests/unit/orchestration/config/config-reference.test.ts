import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { configReference, configReferenceFor } from "../../../../src/orchestration/config/config-reference.js";
import { decodeConfigObject } from "../../../../src/orchestration/config/loader.js";
import { flywheelConfigKeys } from "../../../../src/orchestration/config/schema.js";
import { McpConfigSchema } from "../../../../src/orchestration/modules/mcp/config.js";
import { isRecord, type UnknownRecord } from "../../../../src/infra/record.js";

function tomlTable(text: string): UnknownRecord {
  const parsed = Bun.TOML.parse(text);
  if (!isRecord(parsed)) throw new Error("expected a TOML table");
  return parsed;
}

describe("configuration reference", () => {
  test("projects authored paths, schema defaults, and deterministic examples", () => {
    const disabled = configReference().entries.find(({ path }) => path === "disabled_modules");
    const enabled = configReference().entries.find(({ path }) => path === "enabled_modules");
    const normalized = configReference().entries.find(({ path }) => path === "modules");
    const providerSettings = configReference().entries.find(({ path }) => path === 'profiles."*".providers."*"."*"');
    const rootCap = configReference().entries.find(({ path }) => path === "providers.github_copilot.monthly_credit_cap");
    const thresholds = configReference().entries.find(({ path }) => path === "subscription_usage.alert_thresholds");

    expect(disabled?.authored).toBe(true);
    expect(disabled?.defaultValue).toEqual([]);
    expect(disabled?.example).toContain("disabled_modules = []");
    expect(enabled).toBeUndefined();
    expect(disabled?.example?.split("\n").some((line) => line.startsWith("modules ="))).toBe(false);
    expect(normalized).toBeUndefined();
    expect(providerSettings?.description).toContain("provider module");
    expect(configReference().entries.some(({ path }) => path === "providers.github_copilot.monthly_credit_cap")).toBe(false);
    expect(rootCap).toBeUndefined();
    expect(configReference().example).not.toContain("[providers.github_copilot]");
    expect(configReference().example).toContain("disabled_modules = []");
    expect(thresholds?.defaultValue).toEqual([70, 90, 100]);
    expect(thresholds?.example).toContain("alert_thresholds = [70, 90, 100]");
    expect(configReference().example).toContain("alert_thresholds = [70, 90, 100]");
    expect(() => decodeConfigObject(tomlTable(configReference().example), [], "/configuration.md")).not.toThrow();
  });

  test("fails when a definition and schema conflict on descriptions", () => {
    expect(() => configReferenceFor([
      { id: "showThinking", ownership: "generated-writer", path: ["x"], schema: Schema.String.pipe(Schema.annotate({ description: "schema" })), presentation: { kind: "simple-boolean" } },
    ], Schema.Struct({ x: Schema.optionalKey(Schema.String) }))).toThrow("Conflicting descriptions");
  });
});

describe("configuration reference coverage", () => {
  test("covers every public schema root and omits retired roots", () => {
    const roots = new Set(configReference().entries.map(({ schemaPath }) => schemaPath.split(".")[0]));
    const decodedRoots = new Set([...flywheelConfigKeys()].map((key) => key === "disabled_modules" ? "modules" : key));
    expect([...roots].toSorted()).toEqual([...decodedRoots].toSorted());
    for (const retired of ["capability_modules", "enabled_modules", "features", "queue"]) expect(roots.has(retired)).toBe(false);
  });

  test("derives literal and numeric constraints and distinguishes decoded defaults from unset values", () => {
    const diff = configReference().entries.find(({ path }) => path === "diff_colors");
    const foreground = configReference().entries.find(({ path }) => path === "foreground_bash_hold_seconds");
    const roleModel = configReference().entries.find(({ path }) => path === 'profiles."*".roles."*".model');
    expect(diff?.constraints).toMatchObject({ enum: ["theme", "standard"] });
    expect(JSON.stringify(foreground?.constraints)).toContain('"minimum":1');
    expect(diff?.defaultState).toEqual({ kind: "decoded", value: "theme" });
    expect(roleModel?.defaultState).toEqual({ kind: "unset" });
    expect(configReference().entries.find(({ path, branch }) => path === 'mcp.servers."*".enabled' && branch?.includes("stdio"))?.defaultState).toEqual({ kind: "decoded", value: true });
    expect(configReference().entries.find(({ path, branch }) => path === 'mcp.servers."*".args' && branch?.includes("stdio"))?.defaultState).toEqual({ kind: "decoded", value: [] });
    expect(configReference().entries.find(({ path }) => path === 'custom_providers."*".models')?.defaultState).toEqual({ kind: "decoded", value: [] });
  });

  test("projects dynamic records with concrete safe examples and separate MCP branches", () => {
    expect(configReference().entries.find(({ path }) => path === 'profiles."*".roles."*".model')?.examplePath).toBe('profiles.work.roles."review role".model');
    expect(configReference().entries.some(({ path }) => path.startsWith('profiles."*".roles."*"'))).toBe(true);
    const projectProfile = configReference().entries.find(({ path }) => path === 'auth.project_profiles."*"');
    expect(projectProfile?.example).toContain('"/workspace/project" = "example"');
    expect(configReference().entries.some(({ path }) => path.startsWith('custom_providers."*"'))).toBe(true);
    const mcpEntries = configReference().entries.filter(({ path }) => path.startsWith('mcp.servers."*"'));
    expect(new Set(mcpEntries.map(({ branch }) => branch)).size).toBe(2);
    const stdio = mcpEntries.find(({ path, branch }) => path.endsWith(".enabled") && branch?.includes("stdio"));
    const http = mcpEntries.find(({ path, branch }) => path.endsWith(".enabled") && branch?.includes("HTTP"));
    expect(stdio?.example).toContain('command = "example"');
    const stdioExample = Schema.decodeUnknownSync(Schema.Struct({ mcp: McpConfigSchema }))(Bun.TOML.parse(stdio?.example ?? ""));
    expect(Object.values(stdioExample.mcp.servers).every((server) => server.command !== undefined && server.url === undefined)).toBe(true);
    expect(http?.example).toContain('url = "example"');
    const httpExample = Schema.decodeUnknownSync(Schema.Struct({ mcp: McpConfigSchema }))(Bun.TOML.parse(http?.example ?? ""));
    expect(Object.values(httpExample.mcp.servers).every((server) => server.command === undefined && server.url !== undefined)).toBe(true);
    const projects = configReference().entries.filter(({ path }) => path.startsWith('mcp.projects."*".servers."*"'));
    expect(new Set(projects.map(({ branch }) => branch)).size).toBe(3);
    expect(projects.some(({ branch }) => branch?.includes("enabled-only"))).toBe(true);
  });

  test("omits Never fields and gives open maps an explicit shape", () => {
    expect(configReference().entries.some(({ type }) => type === "never")).toBe(false);
    expect(configReference().entries.some(({ openVocabulary }) => openVocabulary === "open record")).toBe(true);
  });

  test("parses and decodes every rendered user example and the canonical merge", () => {
    for (const entry of configReference().entries) {
      if (entry.ownership === "runtime-owned") {
        expect(entry.example).toBeUndefined();
        expect(entry.snippet.startsWith("# ")).toBe(true);
        continue;
      }
      expect(entry.example).toBeDefined();
      expect(() => decodeConfigObject(tomlTable(entry.example ?? ""), [], "/configuration.md")).not.toThrow();
    }
    expect(() => decodeConfigObject(tomlTable(configReference().example), [], "/configuration.md")).not.toThrow();
  });

  test("escapes dotted, quoted, and control-character record keys", () => {
    const record = Schema.Record(Schema.String, Schema.String.pipe(Schema.annotate({ description: "A value." }))).pipe(Schema.annotate({ description: "Values.", exampleKey: "dot.\"line\n" }));
    const reference = configReferenceFor([{ id: "items", key: "items", schema: record, owner: "items", presentation: { kind: "none" } }], Schema.Struct({ items: record }));
    expect(reference.entries[0]?.examplePath).toContain('"dot.\\\"line\\n"');
    expect(() => Bun.TOML.parse(reference.entries[0]?.example ?? "")).not.toThrow();
  });

  test("fails for missing descriptions and unresolved definitions", () => {
    expect(() => configReferenceFor([{ id: "x", key: "x", schema: Schema.String, presentation: { kind: "none" } }], Schema.Struct({ x: Schema.String }))).toThrow("Missing description");
    expect(() => configReferenceFor([], Schema.Struct({ x: Schema.String }))).toThrow("Unresolved configuration reference");
  });
});
