import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configSection } from "../../../../src/orchestration/config/config-section.js";
import { patchSemanticAssignment } from "../../../../src/orchestration/config/config-assignment.js";
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js";
import { mcpConfigSection } from "../../../../src/orchestration/modules/mcp/config.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

test("compares a selected typed section against fresh source and waits for replacement", async () => {
  const root = temporaryDirectory("runtime-config-section-");
  mkdirSync(join(root, ".flywheel"));
  const configPath = join(root, ".flywheel", "flywheel.toml");
  const initial = 'show_thinking = true\n[mcp.servers.server]\ncommand = "old"\n';
  writeFileSync(configPath, initial);
  const owner = await createRuntimeConfigOwner({ configPath, watch: false });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let applications = 0;
  let publications = 0;
  const thinking: boolean[] = [];
  let sharedApplications = 0;
  const sharedSubscriber = () => { sharedApplications += 1; };
  owner.subscribeAll(() => { publications += 1; });
  owner.subscribe("showThinking", (snapshot) => { thinking.push(snapshot.config.show_thinking); });
  owner.subscribe("showThinking", sharedSubscriber);
  owner.subscribe(mcpConfigSection, sharedSubscriber);
  owner.subscribe(mcpConfigSection, async () => {
    applications += 1;
    entered.resolve();
    await release.promise;
  });
  const select = (section: ReturnType<typeof configSection<typeof mcpConfigSection.schema>>) => section.servers.server?.command ?? null;
  const patch = (source: string) => patchSemanticAssignment(source, ["mcp", "servers", "server", "command"], '"new"') ?? source;
  try {
    writeFileSync(configPath, initial.replace("true", "false"));
    let settled = false;
    const mutation = owner.mutateSection(mcpConfigSection, "old", select, (source, section) => {
      expect(section.servers.server?.command).toBe("old");
      return patch(source);
    }).then((result) => { settled = true; return result; });
    await entered.promise;
    expect(settled).toBe(false);
    expect(owner.snapshot().config.show_thinking).toBe(false);
    expect(publications).toBe(1);
    release.resolve();
    expect((await mutation).ok).toBe(true);
    expect(applications).toBe(1);
    expect(thinking).toEqual([false]);
    expect(sharedApplications).toBe(1);
    const committed = owner.snapshot();
    expect(await owner.refresh()).toBe(committed);
    expect(thinking).toEqual([false]);
    expect(applications).toBe(1);
    expect(sharedApplications).toBe(1);
    const before = readFileSync(configPath, "utf8").replace('"new"', '"external"');
    writeFileSync(configPath, before);
    const stale = await owner.mutateSection(mcpConfigSection, "new", select, patch);
    expect(stale.ok ? "committed" : stale.kind).toBe("stale");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const malformed = await owner.mutateSection(mcpConfigSection, "external", select, () => "[mcp]\nservers = [\n");
    expect(malformed.ok ? "committed" : malformed.kind).toBe("parse-or-decode-failed");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(publications).toBe(1);
  } finally {
    release.resolve();
    await owner.dispose();
  }
});
