import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadStandalonePersonaRegistry } from "../../../../../src/workflows/agents/registry.js";
import { repoDefinitions } from "../../../../helpers/project-definitions.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

const ROOT = fileTemporaryDirectory("flywheel-agent-loader-test-");

function writePersona(name: string, frontmatter: string, body: string): void {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

async function loadPersona(name: string, frontmatter: string, body: string) {
  rmSync(ROOT, { recursive: true, force: true });
  writePersona(name, frontmatter, body);
  const registry = loadStandalonePersonaRegistry(ROOT, repoDefinitions().skills());
  rmSync(ROOT, { recursive: true, force: true });
  return registry.get(name);
}

const BASE = 'name: auditor\ndescription: Audits code.\nrole: reviewer\ntools: ["read"]';

describe("loadStandalonePersonaRegistry", () => {
  // Ids the live registry actually installs: a persona that names an
  // uninstalled package no longer loads at all (see below).
  it("carries a persona's declared requiredSkills into its definition", async () => {
    const agent = await loadPersona("auditor", `${BASE}\nrequiredSkills: ["implementation-planning", "code-review"]`, "Role body.");

    if (agent?.kind !== "persona") throw new Error(`expected a persona definition, got ${agent?.kind}`);
    expect(agent.requiredSkills).toEqual(["implementation-planning", "code-review"]);
  });

  it("fails the load when a persona requires an uninstalled skill", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    writePersona("auditor", `${BASE}\nrequiredSkills: ["implementation-planning", "not-installed"]`, "Role body.");

    // The composition runs with no model in the loop, so the miss is a load
    // error, not a dispatch-time surprise.
    expect(() => loadStandalonePersonaRegistry(ROOT, repoDefinitions().skills())).toThrow(
      'Persona "auditor" requires uninstalled skill(s): not-installed',
    );
    rmSync(ROOT, { recursive: true, force: true });
  });

  it("leaves requiredSkills absent when the persona declares none", async () => {
    const agent = await loadPersona("auditor", BASE, "Role body.");

    expect(agent).toBeDefined();
    expect(agent && "requiredSkills" in agent).toBe(false);
  });

  it("skips a persona whose requiredSkills is not a list of ids", async () => {
    const agent = await loadPersona("auditor", `${BASE}\nrequiredSkills: "auditing"`, "Role body.");

    expect(agent).toBeUndefined();
  });
});
