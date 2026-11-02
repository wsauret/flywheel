import { describe, expect, it } from "bun:test";
import { installedDefinitionBundles } from "../../../src/orchestration/module-catalog.js";
import { installedPersonaToolEntries } from "../../../src/orchestration/tool-catalog.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import { createProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js";
import { testDirectories } from "../../helpers/directories.js";

const definitions = createProjectDefinitionRegistry({
  bundles: [],
  ...testDirectories(process.cwd()),
  skillRoots: [],
  personaToolEntries: installedPersonaToolEntries(),
});

describe("skill rosters", () => {
  it("keeps shipping as a child-only package", () => {
    expect(definitions.skills().skills.get("ship")).toMatchObject({ modelInvocable: false });
  });

  it("loads the development module's bundle only when a composition passes it", () => {
    const bundles = installedDefinitionBundles(DEVELOPMENT_MODULES);
    const withBundle = createProjectDefinitionRegistry({ ...testDirectories(process.cwd()), skillRoots: [], bundles }).skills();
    const typescriptBun = withBundle.skills.get("typescript-bun");
    expect(typescriptBun?.source.kind === "filesystem" ? typescriptBun.source.bundle : undefined).toBe("development");
    expect(withBundle.corePackages.has("typescript-bun")).toBe(false);
    expect(definitions.skills().skills.has("typescript-bun")).toBe(false);
  });
});
