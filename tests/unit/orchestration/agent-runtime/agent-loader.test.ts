import { describe, expect, it, spyOn } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Log } from "../../../../src/infra/log.js";
import { loadStandalonePersonaRegistry } from "../../../../src/workflows/agents/registry.js";
import { personaIdentitySha256 } from "../../../../src/workflows/vm/definition-identity.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";

const SKILL_REVISION = repoDefinitions().skills();
const PERSONA_DIR = fileURLToPath(new URL("../../../../src/workflows/agents/personas", import.meta.url));

describe("loadStandalonePersonaRegistry", () => {
  it("skips persona files that disappear between directory listing and read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    try {
      writeFileSync(join(dir, "valid.md"), [
        "---",
        "name: valid-agent",
        "description: Valid agent",
        "role: reviewer",
        "tools:",
        "  - read",
        "---",
        "Use evidence.",
      ].join("\n"));
      symlinkSync(join(dir, "missing-target.md"), join(dir, "dangling.md"));

      const registry = await loadStandalonePersonaRegistry(dir, SKILL_REVISION);

      expect(registry.get("valid-agent")).toMatchObject({ kind: "persona", role: "reviewer" });
      expect(registry.has("dangling")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns loudly when a persona file is unreadable but keeps the valid ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    const warn = spyOn(Log.create({ service: "agent-registry" }), "warn");
    try {
      writeFileSync(join(dir, "broken.md"), "no frontmatter here");
      writeFileSync(join(dir, "valid.md"), [
        "---",
        "name: valid-agent",
        "description: Valid agent",
        "role: reviewer",
        "tools:",
        "  - read",
        "---",
        "Use evidence.",
      ].join("\n"));

      const registry = await loadStandalonePersonaRegistry(dir, SKILL_REVISION);

      expect(registry.has("valid-agent")).toBe(true);
      const warned = warn.mock.calls.some(([msg, extra]) =>
        msg === "skipping unreadable persona file"
        && typeof extra?.filePath === "string"
        && extra.filePath.endsWith("broken.md"));
      expect(warned).toBe(true);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads persona files with CRLF line endings through the shared frontmatter parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    try {
      writeFileSync(join(dir, "crlf.md"), [
        "---",
        "name: crlf-agent",
        "description: CRLF agent",
        "role: reviewer",
        "tools:",
        "  - read",
        "---",
        "Use evidence.",
      ].join("\r\n"));

      const registry = await loadStandalonePersonaRegistry(dir, SKILL_REVISION);

      expect(registry.get("crlf-agent")).toMatchObject({ kind: "persona", systemPrompt: "Use evidence." });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads persona files from nested installed agent directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    try {
      mkdirSync(join(dir, "reviewers"));
      writeFileSync(join(dir, "reviewers", "nested.md"), [
        "---",
        "name: nested-agent",
        "description: Nested agent",
        "role: reviewer",
        "tools:",
        "  - read",
        "---",
        "Use nested evidence.",
      ].join("\n"));

      const registry = await loadStandalonePersonaRegistry(dir, SKILL_REVISION);

      expect(registry.get("nested-agent")).toMatchObject({ kind: "persona", systemPrompt: "Use nested evidence." });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a persona file that sets the retired prompt switches without them, so its identity matches the same file without them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    const plain = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    try {
      const scout = (switches: readonly string[]) => ["---", "name: scout", "description: Path finder", "role: explorer", ...switches, "tools:", "  - read", "---", "Find paths."].join("\n");
      // The shape persona files had before 2026-10-14, when these keys set a child's stable prompt apart.
      writeFileSync(join(dir, "scout.md"), scout(["projectContext: false", "engineeringDoctrine: false"]));
      writeFileSync(join(plain, "scout.md"), scout([]));

      const retired = (await loadStandalonePersonaRegistry(dir, SKILL_REVISION)).get("scout");
      const current = (await loadStandalonePersonaRegistry(plain, SKILL_REVISION)).get("scout");

      expect(retired).toEqual(current);
      expect(retired).not.toHaveProperty("projectContext");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  });

  // An override renders its capability markers raw, so a byte-identical copy
  // is a different procedure: a resumed workflow must report it as drift.
  it("gives a byte-identical project override of a marker-bearing bundled persona its own identity, and the override hashes as an external persona", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "flywheel-agent-loader-"));
    try {
      copyFileSync(join(PERSONA_DIR, "ship.md"), join(projectDir, "ship.md"));
      const bundled = loadStandalonePersonaRegistry(PERSONA_DIR, SKILL_REVISION).get("ship");
      const override = loadStandalonePersonaRegistry(PERSONA_DIR, SKILL_REVISION, undefined, undefined, projectDir).get("ship");
      if (bundled?.kind !== "persona" || override?.kind !== "persona") throw new Error("Missing persona: ship");

      expect(override.systemPrompt).toBe(bundled.systemPrompt);
      expect(override.systemPrompt).toContain("{{if:bash}}");
      expect(personaIdentitySha256(override)).not.toBe(personaIdentitySha256(bundled));
      const { bundled: _mark, ...external } = bundled;
      expect(personaIdentitySha256(override)).toBe(personaIdentitySha256(external));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
