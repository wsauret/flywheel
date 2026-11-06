/** The Claude plugin carries Flywheel's own prompts into another agent host. Its text must name only what that host
 *  offers, under the names the host lists, its manifest must carry the release version (the host installs an update
 *  only when the version changes), and its zip must be the same bytes on every build, because the marketplace pins
 *  the zip's digest. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../../src/infra/frontmatter.js";
import { SHIPPED_MODULES } from "../../../src/orchestration/modules.js";
import { createToolRegistry } from "../../../src/orchestration/tool-catalog.js";
import { buildClaudePlugin, writePluginDirectory } from "../../../scripts/build-claude-plugin.js";
import { NATIVE_TOOLS } from "../../../scripts/claude-plugin-host.js";
import { zipArchive } from "../../../scripts/zip-archive.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const plugin = buildClaudePlugin("9.8.7", "Plugin Author");
const temporary = temporaryDirectories();
/** The maintainer's harness-name checker. A contributor checkout has no private folder, and then the check skips. */
const HARNESS_NAMES = join(import.meta.dir, "..", "..", "..", "private", "scripts", "check-harness-names.ts");

function document(path: string) {
  const text = plugin.files.get(path);
  if (text === undefined) throw new Error(`The plugin has no ${path}`);
  const parsed = parseFrontmatter(text);
  if (parsed === null) throw new Error(`${path} has no frontmatter`);
  return { frontmatter: parsed.frontmatter, body: parsed.body.trim() };
}

/** Every skill and agent that the plugin ships, by its bare name. */
const pluginNames = [...plugin.files.keys()].flatMap((path) => /^(?:skills\/([^/]+)\/SKILL|agents\/([^/]+))\.md$/.exec(path)?.slice(1).filter((name) => name !== undefined) ?? []);

describe("Claude plugin export", () => {
  test("the manifest carries the release version and the settings make Flywheel's chat agent the main agent", () => {
    expect(JSON.parse(plugin.files.get(".claude-plugin/plugin.json") ?? "")).toMatchObject({ name: "flywheel", version: "9.8.7", author: { name: "Plugin Author" } });
    expect(JSON.parse(plugin.files.get("settings.json") ?? "")).toEqual({ agent: "flywheel" });
  });

  test("the main agent is the chat body for the host plus the engineering doctrine, with every host tool", () => {
    const { frontmatter, body } = document("agents/flywheel.md");
    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(body).toStartWith("You are Flywheel's chat agent.");
    expect(body).toContain("The host compacts the earlier conversation into a summary");
    expect(body).toContain("# Working method");
    expect(body).toContain("The `Bash` tool is a good route");
    expect(body).toContain("Use `AskUserQuestion` only after the discussion has settled");
    expect(body).toContain("load the `flywheel:design` skill");
    expect(body).toContain("load the `flywheel:code-review` skill");
    expect(body).toContain("ELEGANCE:");
    for (const flywheelOnly of ["AGENTS.md", "memory", "session notes", "system turns", "# Working in Flywheel"]) expect(body).not.toContain(flywheelOnly);
  });

  test("a persona agent gets the host tools for its Flywheel tools, its role's model, and its required skills", () => {
    expect(document("agents/advisor.md").frontmatter).toMatchObject({ tools: "Bash, Read", model: "claude-fable-5-1" });
    expect(document("agents/explorer.md").frontmatter).toMatchObject({ tools: "Bash, Read, WebSearch, WebFetch, Skill", model: "haiku" });
    expect(document("agents/reviewer-plan-design.md").frontmatter).toMatchObject({ model: "opus", skills: ["plan-review", "interface-design"] });
    expect(document("agents/advisor.md").body).toContain("Use `Read` and read-only shell commands such as `grep` and `find`");
    expect(String(document("agents/explorer.md").frontmatter["description"])).toEndWith("dispatch general-purpose instead.");
    expect(document("agents/implementer.md").body).toContain("stop and return to your parent with the evidence and the decision that it needs");
  });

  test("the main agent names no workflow, because the host runs none", () => {
    expect(document("agents/flywheel.md").body).not.toMatch(/workflow/i);
  });

  test("a skill carries its composed skills and shared references, and names the plugin agents it dispatches", () => {
    const { frontmatter, body } = document("skills/code-review/SKILL.md");
    expect(frontmatter).toEqual({ name: "code-review", description: "Review completed code or a plan with right-sized specialist agents." });
    expect(body).toContain("# Skill: elegance-review-principles");
    expect(body).toContain("multiple `Agent` calls in one parent turn");
    expect(body).toContain("`flywheel:reviewer-code-quality`");
    expect(document("skills/design/SKILL.md").body).toContain("`AskUserQuestion`");
  });

  test("a dispatched agent receives the approved intent in its prompt, because the host carries nothing else to it", () => {
    expect(document("skills/design/SKILL.md").body).toContain("give each agent that implements or reviews the work the approved intent and decisions verbatim");
    expect(document("skills/code-review/SKILL.md").body).toContain("- Design intent (fixed): [the approved Design intent and the user's dated decisions, verbatim]");
    for (const [path, text] of plugin.files) expect({ path, checkpoint: /checkpoint|runtime carries/.test(text) }).toEqual({ path, checkpoint: false });
  });

  test("a unit that needs Flywheel's runtime, a tool the host lacks, or a unit left out is left out, with its reason", () => {
    expect(plugin.exclusions).toContainEqual({ kind: "skill", id: "worktree-lifecycle", reason: "its text names ship, which is left out" });
    for (const id of ["workflow-authoring", "experiment-charter", "experiment-finalize", "ship"]) {
      expect(plugin.exclusions.some((exclusion) => exclusion.kind === "skill" && exclusion.id === id)).toBe(true);
      expect(plugin.files.has(`skills/${id}/SKILL.md`)).toBe(false);
    }
    expect(plugin.files.has("agents/ship.md")).toBe(false);
    expect(plugin.exclusions.map(({ kind, id }) => `${kind}:${id}`).toSorted()).toEqual([
      "agent:ship", "skill:experiment-charter", "skill:experiment-finalize", "skill:ship", "skill:workflow-authoring", "skill:worktree-lifecycle",
    ]);
  });

  test("exported text names each plugin skill and agent by its plugin name, and no unit that is left out", () => {
    const leftOut = plugin.exclusions.map(({ id }) => id);
    for (const [path, text] of plugin.files) {
      for (const name of [...pluginNames, ...leftOut]) expect({ path, bare: text.includes(`\`${name}\``) }).toEqual({ path, bare: false });
    }
  });

  test("no exported text names a Flywheel tool that the host does not offer under that name", () => {
    const flywheelOnly = [...createToolRegistry(SHIPPED_MODULES).values()].map(({ tool }) => tool).filter((name) => !NATIVE_TOOLS.has(name));
    for (const [path, text] of plugin.files) {
      for (const name of NATIVE_TOOLS.keys()) expect({ path, name, named: text.includes(`\`${name}\``) }).toEqual({ path, name, named: false });
      for (const name of flywheelOnly) {
        const named = text.includes(`\`${name}\``) || (name.includes("_") && new RegExp(`\\b${name}\\b`).test(text));
        expect({ path, name, named }).toEqual({ path, name, named: false });
      }
    }
  });

  test.skipIf(!existsSync(HARNESS_NAMES))("no exported text names another agent harness", async () => {
    const { findHarnessNames } = await import(HARNESS_NAMES);
    const dir = temporary("flywheel-claude-plugin-names-");
    writePluginDirectory(plugin, dir);
    // The checker exempts the paths that the notices cite; the plugin cites none, so every file is checked.
    writeFileSync(join(dir, "THIRD-PARTY-NOTICES.md"), "");
    expect(findHarnessNames(dir, [...plugin.files.keys()])).toEqual([]);
  });

  test("the zip is the same bytes on every build", () => {
    const digest = (): string => createHash("sha256").update(zipArchive(buildClaudePlugin("9.8.7", "Plugin Author").files)).digest("hex");
    expect(digest()).toBe(digest());
  });
});
