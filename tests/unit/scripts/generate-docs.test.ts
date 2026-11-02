import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGeneratedDocs, writeGeneratedDocs } from "../../../scripts/generate-docs.js";
import { constraintSummary, renderConfigurationDocs } from "../../../scripts/render-config-docs.js";
import { renderCliReference, renderCommandReference } from "../../../scripts/render-reference-docs.js";
import { commandSyntax, rootHelp } from "../../../src/cli/root-help.js";
import { configReference } from "../../../src/orchestration/config/config-reference.js";
import { FlywheelConfigSchema } from "../../../src/orchestration/config/schema.js";
import { SHIPPED_MODULES } from "../../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import { createKeymap } from "../../../src/tui/keymap/keymap.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("generated user documentation", () => {
  test("renders every entry with complete public metadata", () => {
    const rendered = renderConfigurationDocs();
    for (const entry of configReference().entries) {
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
    expect(applicationLines.length).toBeGreaterThanOrEqual(configReference().entries.length);
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
    for (const entry of configReference().entries) {
      const heading = `### \`${entry.path}\``;
      const sections = rendered.split(heading).slice(1).map((section) => section.split("\n### ")[0] ?? "");
      const section = entry.branch === undefined ? sections[0] : sections.find((candidate) => candidate.includes(`- Branch: ${entry.branch}`));
      const code = section?.match(/```toml\n([\s\S]*?)\n```/)?.[1] ?? "";
      expect(code).toBe(entry.snippet);
      if (entry.ownership === "runtime-owned") expect(code.startsWith("# ")).toBe(true);
      else {
        expect(entry.example).toBe(code);
        expect(() => Schema.decodeUnknownSync(FlywheelConfigSchema)(Bun.TOML.parse(code))).not.toThrow();
      }
    }
    const keybindings = configReference().entries.find((entry) => entry.path.startsWith("keybindings"))?.example ?? "";
    const overrides = Schema.decodeUnknownSync(FlywheelConfigSchema)(Bun.TOML.parse(keybindings)).keybindings;
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
    expect(createKeymap(overrides).issues).toEqual([]);
  });

  test("checker reports missing and drifted pages without mutation, and a write makes every page current", async () => {
    const root = temporaryDirectory("generated-docs-");
    expect((await checkGeneratedDocs(root)).map(({ status }) => status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(readdirSync(root)).toEqual([]);
    await writeGeneratedDocs(root);
    const written = readdirSync(root).toSorted().map((file) => readFileSync(join(root, file)));
    await writeGeneratedDocs(root);
    expect(readdirSync(root).toSorted().map((file) => readFileSync(join(root, file)))).toEqual(written);
    expect((await checkGeneratedDocs(root)).every(({ status }) => status === "current")).toBe(true);
    writeFileSync(join(root, "keys.md"), `${readFileSync(join(root, "keys.md"), "utf8")}x`);
    const before = readFileSync(join(root, "keys.md"));
    expect(await checkGeneratedDocs(root)).toContainEqual({ file: "keys.md", status: "different" });
    expect(readFileSync(join(root, "keys.md"))).toEqual(before);
  });

  test("the CLI reference lists every option, every shipped command, and no development noun", async () => {
    const rendered = await renderCliReference();
    const { kernel, contributed, options } = await rootHelp(SHIPPED_MODULES);
    const visible = (text: string): string => text.replaceAll(/(<[^<>\s]+>)/g, "`$1`");
    for (const { flags, description } of options) expect(rendered).toContain(`| \`${flags}\` | ${visible(description)}`);
    for (const { noun, verbs } of [...kernel, ...contributed]) {
      for (const verb of verbs) expect(rendered).toContain(`| \`flywheel ${commandSyntax(noun, verb).replaceAll("|", "\\|")}\` | ${visible(verb.description)} |`);
    }
    const developmentNouns = DEVELOPMENT_MODULES.flatMap((module) => module.contributions.flatMap((contribution) => contribution.domain === "cli" ? [contribution.id] : []));
    expect(developmentNouns.length).toBeGreaterThan(0);
    for (const noun of developmentNouns) expect(rendered).not.toContain(`flywheel ${noun}`);
  });

  test("a placeholder in a description renders as code, not HTML", async () => {
    expect(renderCommandReference()).toContain("| Run an experiment loop: design `<goal>`, start, off, clear, finalize, or dashboard |");
    expect(await renderCliReference()).toContain("'flywheel remote machines add `<link>`'.");
  });

  test("rejects missing metadata", () => {
    const entry = configReference().entries[0];
    if (entry === undefined) throw new Error("Expected configuration reference entries");
    const invalidReference = { ...configReference(), entries: [{ ...entry, description: "" }] };
    expect(() => renderConfigurationDocs(invalidReference)).toThrow("Missing description");
  });

});
