import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAssetMarkerFindings, knownCapabilityTerm } from "../../../scripts/check-bundled-skills.js";
import { bundledAgentAsset, type AgentAssetName } from "../../../src/infra/agent-assets/system-prompt.js";
import { installedDefinitionBundles } from "../../../src/orchestration/module-catalog.js";
import { installedPersonaToolEntries } from "../../../src/orchestration/tool-catalog.js";
import { createProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js";

const root = mkdtempSync(join(tmpdir(), "flywheel-bundled-skills-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const known = knownCapabilityTerm(createProjectDefinitionRegistry({ projectRoot: root, userDataRoot: root, accountHome: root, skillRoots: [], bundles: installedDefinitionBundles(), personaToolEntries: installedPersonaToolEntries() }));

/** The bundled assets with `name` changed by `mutate`. */
const mutated = (name: AgentAssetName, mutate: (text: string) => string) => (asset: AgentAssetName) => asset === name ? mutate(bundledAgentAsset(asset)) : bundledAgentAsset(asset);

describe("agent asset capability markers", () => {
  test("pass on the bundled assets", () => {
    expect(agentAssetMarkerFindings(known)).toEqual([]);
  });

  for (const name of ["system-prompt.md", "engineering-doctrine.md"] as const) {
    test(`reject an unknown term and an unclosed block in ${name}`, () => {
      expect(agentAssetMarkerFindings(known, mutated(name, (text) => text.replace("{{if:bash}}", "{{if:bsah}}")))).toEqual([
        `bundled-agent-asset: ${name}: capability marker names unknown term "bsah"`,
      ]);
      const unclosed = agentAssetMarkerFindings(known, mutated(name, (text) => text.slice(0, text.lastIndexOf("{{end}}"))));
      expect(unclosed).toHaveLength(1);
      expect(unclosed[0]).toMatch(new RegExp(`^bundled-agent-asset: ${name.replace(".", "\\.")}: Capability block opened at line \\d+ has no \\{\\{end\\}\\}$`));
    });
  }
});
