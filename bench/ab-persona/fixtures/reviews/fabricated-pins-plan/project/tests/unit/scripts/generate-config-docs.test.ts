import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfigurationDocs } from "../../../scripts/check-config-docs.js";
import { constraintSummary, renderConfigurationDocs } from "../../../scripts/generate-config-docs.js";
import { CONFIG_REFERENCE } from "../../../src/orchestration/config/config-reference.js";
import { FlywheelConfigSchema } from "../../../src/orchestration/config/schema.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(import.meta.dir, "generate-config-docs-"));
}

describe("configuration documentation generation", () => {
  test("renders the subscription usage threshold array as a decodable authored example", () => {
    const entry = CONFIG_REFERENCE.entries.find(({ path }) => path === "subscription_usage.alert_thresholds");
    expect(entry?.type).toBe("array");
    expect(entry?.defaultValue).toEqual([70, 90, 100]);
    expect(entry?.example).toContain("alert_thresholds = [70, 90, 100]");
    expect(() => Schema.decodeUnknownSync(FlywheelConfigSchema)(Bun.TOML.parse(entry?.example ?? ""))).not.toThrow();
  });

  test("renders every entry with complete public metadata", () => {
    const rendered = renderConfigurationDocs();
    for (const entry of CONFIG_REFERENCE.entries) {
      expect(rendered).toContain(`### \`${entry.path}\``);
      expect(rendered).toContain(`- Type: \`${entry.type}\``);
      expect(rendered).toContain(entry.description);
      expect(rendered).toContain(entry.defaultState.kind === "unset" ? "- Default: unset" : `- Default: \`${JSON.stringify(entry.defaultState.value)}\``);
      const summary = entry.openVocabulary === undefined && !Array.isArray(entry.constraints?.enum) ? constraintSummary(entry.constraints) : undefined;
      if (entry.openVocabulary !== undefined) expect(rendered).toContain(`- Shape: ${entry.openVocabulary}`);
      else if (Array.isArray(entry.constraints?.enum)) expect(rendered).toContain("- Allowed values:");
      else if (summary !== undefined) expect(rendered).toContain(`- Constraints: ${summary}`);
      if (entry.branch !== undefined) expect(rendered).toContain(`- Branch: ${entry.branch}`);
    }
    const applicationLines = rendered.match(/\n- Application: /g) ?? [];
    expect(applicationLines.length).toBeGreaterThanOrEqual(CONFIG_REFERENCE.entries.length);
    const persistentSection = rendered.split("### `allow_persistent_processes`")[1]?.split("\n### ")[0] ?? "";
    expect(persistentSection).toContain("`next-request`");
    expect(persistentSection).toContain("`use-time-revalidate`");
    const reviewSection = rendered.split("### `skills.review_interval_iterations`")[1]?.split("\n### ")[0] ?? "";
    expect(reviewSection).toContain("`next-request`");
    expect(reviewSection).not.toContain("`next-use`");
    const maintenanceSection = rendered.split("### `skills.stale_after_days`")[1]?.split("\n### ")[0] ?? "";
    expect(maintenanceSection).toContain("`next-use`");
    expect(maintenanceSection).not.toContain("`next-request`");
    expect(rendered).not.toContain("- Ownership:");
    expect(rendered).not.toContain("- Sensitivity:");
  });

  test("produces deterministic UTF-8 LF bytes with one final newline", () => {
    const first = renderConfigurationDocs();
    expect(new TextEncoder().encode(first)).toEqual(new TextEncoder().encode(renderConfigurationDocs()));
    expect(first.includes("\r")).toBe(false);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  test("renders and decodes each entry's authored example", () => {
    const rendered = renderConfigurationDocs();
    for (const entry of CONFIG_REFERENCE.entries) {
      const heading = `### \`${entry.path}\``;
      const sections = rendered.split(heading).slice(1).map((section) => section.split("\n### ")[0] ?? "");
      const section = entry.branch === undefined ? sections[0] : sections.find((candidate) => candidate.includes(`- Branch: ${entry.branch}`));
      const code = section?.match(/```toml\n([\s\S]*?)\n```/)?.[1] ?? "";
      expect(code).toBe(entry.ownership === "runtime-owned" ? entry.snippet : entry.example);
      if (entry.ownership === "runtime-owned") expect(code.startsWith("# ")).toBe(true);
      else expect(() => Schema.decodeUnknownSync(FlywheelConfigSchema)(Bun.TOML.parse(code))).not.toThrow();
    }
  });

  test("matches the checked-in source artifact", () => {
    expect(readFileSync(join(import.meta.dir, "../../../src/workflows/docs/configuration.md"), "utf8")).toBe(renderConfigurationDocs());
  });

  test("checker reports missing and drifted artifacts without mutation", () => {
    const root = temporaryDirectory();
    const artifact = join(root, "configuration.md");
    try {
      expect(checkConfigurationDocs(artifact)).toEqual({ ok: false, reason: "missing" });
      expect(existsSync(artifact)).toBe(false);
      writeFileSync(artifact, `${renderConfigurationDocs()}x`);
      const before = readFileSync(artifact);
      expect(checkConfigurationDocs(artifact)).toEqual({ ok: false, reason: "different" });
      expect(readFileSync(artifact)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects missing metadata before reading the artifact", () => {
    const entry = CONFIG_REFERENCE.entries[0];
    if (entry === undefined) throw new Error("Expected configuration reference entries");
    const invalidReference = { ...CONFIG_REFERENCE, entries: [{ ...entry, description: "" }] };
    expect(() => checkConfigurationDocs("/path/that/does/not/exist", invalidReference)).toThrow("Missing description");
  });

  test("registers the exact lint fan-out step", () => {
    const packageJson = readFileSync(join(import.meta.dir, "../../../package.json"), "utf8");
    const lintParallel = readFileSync(join(import.meta.dir, "../../../scripts/lint-parallel.ts"), "utf8");
    expect(JSON.parse(packageJson).scripts["lint:config-docs"]).toBe("bun run scripts/check-config-docs.ts");
    expect(lintParallel).toContain('"config-docs"');
  });
});
