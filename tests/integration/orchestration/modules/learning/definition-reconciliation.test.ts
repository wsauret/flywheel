import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchDefinitionRoots, type DefinitionRootWatch } from "../../../../../src/orchestration/app-service/definition-root-watcher.js";
import { reconcileDefinitionRoots } from "../../../../../src/orchestration/modules/learning/definition-reconciliation.js";
import type { ModulePolicy } from "../../../../../src/orchestration/config/module-policy.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../../../../../src/workflows/definition-registry.js";
import type { SkillRegistryRevision } from "../../../../../src/workflows/skill-schema.js";
import type { SkillStoreRoot } from "../../../../../src/workflows/skills.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

// Integration tier: the pass condition is real filesystem event delivery, whose
// latency exceeds any useful deadline when the parallel unit shards saturate the
// CPU. Run serially here instead.
const DEBOUNCE_MS = 5;

// Every case gets its own directories so no case observes another's files or
// leftover events.
let caseDir = "";
let ownedRoot = "";
let sharedRoot = "";
let watcher: DefinitionRootWatch | undefined;
let definitions: ProjectDefinitionRegistry | undefined;

beforeEach(() => {
  caseDir = temporaryDirectory("flywheel-skill-watcher-");
  ownedRoot = join(caseDir, "flywheel-skills");
  sharedRoot = join(caseDir, "agents-skills");
});

afterEach(async () => {
  await watcher?.dispose();
  watcher = undefined;
  definitions = undefined;
});
// Registered after the hook above, so each watcher stops before its case
// directory is removed.
const temporaryDirectory = temporaryDirectories();

// Watching real files means the reload lands a few event loop turns later; poll
// instead of sleeping a fixed guess so the test is neither slow nor flaky.
async function waitFor(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
  }
}

function writeSkill(root: string, dirName: string, description: string): void {
  mkdirSync(join(root, dirName), { recursive: true });
  writeFileSync(join(root, dirName, "SKILL.md"), `---\ndescription: ${description}\n---\nBody.`);
}

/** The watch observes the same roots its registry loads, and starts first:
 *  it creates the owned stores, and a change after it is either in the load
 *  or in an event. The registry then names what a change runs. */
function startWatcher(onReloaded: () => void | Promise<void>, roots: readonly SkillStoreRoot[], capabilities?: Pick<ModulePolicy, "admit">): void {
  watcher = watchDefinitionRoots({ roots, debounceMs: DEBOUNCE_MS });
  definitions = createProjectDefinitionRegistry({ bundles: [], projectRoot: join(caseDir, "project"), accountHome: join(caseDir, "home"), userDataRoot: join(caseDir, "home", ".flywheel"), skillRoots: roots });
  watcher.bind({
    reload: () => skillOwner().reload(),
    onReloaded,
    beforeReload: () => reconcileDefinitionRoots({ roots, ...(capabilities ? { capabilities } : {}) }),
  });
}

function skillOwner(): ProjectDefinitionRegistry {
  if (!definitions) throw new Error("this case started no watcher");
  return definitions;
}

function installed(): SkillRegistryRevision {
  return skillOwner().skills();
}

function owned(...dirs: string[]): SkillStoreRoot[] {
  return dirs.map((dir) => ({ dir, owned: true, reach: "global" as const }));
}

describe("watchDefinitionRoots", () => {
  it("creates every owned store so a first skill install or write is observable", () => {
    const projectRoot = join(caseDir, "project-skills");
    expect(existsSync(projectRoot)).toBe(false);
    expect(existsSync(ownedRoot)).toBe(false);

    startWatcher(() => {}, [...owned(projectRoot, ownedRoot), { dir: sharedRoot, owned: false, reach: "global" }]);

    expect(existsSync(projectRoot)).toBe(true);
    expect(existsSync(ownedRoot)).toBe(true);
    // The shared root belongs to other harnesses; absence must not create it.
    expect(existsSync(sharedRoot)).toBe(false);
  });

  it("reloads the live skill registry when a skill is added and removed", async () => {
    let reloads = 0;
    startWatcher(() => { reloads += 1 }, [...owned(ownedRoot), { dir: sharedRoot, owned: false, reach: "global" }]);

    writeSkill(ownedRoot, "watched-probe", "Watched probe");
    await waitFor("the added skill", () => installed().skills.has("watched-probe"));
    expect(installed().skills.get("watched-probe")?.trigger).toBe("Watched probe");
    expect(reloads).toBeGreaterThan(0);

    rmSync(join(ownedRoot, "watched-probe"), { recursive: true, force: true });
    await waitFor("the removed skill", () => !installed().skills.has("watched-probe"));
  });

  it("publishes each reload as a whole new revision", async () => {
    startWatcher(() => {}, owned(ownedRoot));
    const before = installed();

    writeSkill(ownedRoot, "revision-probe", "Revision probe");
    await waitFor("the added skill", () => installed().skills.has("revision-probe"));

    const after = installed();
    expect(after.revision).toBeGreaterThan(before.revision);
    // The revision a caller already holds never changes under it.
    expect(before.skills.has("revision-probe")).toBe(false);
  });

  it("keeps the valid skills when a malformed package is installed", async () => {
    let reloads = 0;
    startWatcher(() => { reloads += 1 }, owned(ownedRoot));
    writeSkill(ownedRoot, "valid-probe", "Valid probe");
    await waitFor("the valid skill", () => installed().skills.has("valid-probe"));
    const reloadsBeforeMalformed = reloads;

    mkdirSync(join(ownedRoot, "broken-probe"), { recursive: true });
    writeFileSync(join(ownedRoot, "broken-probe", "SKILL.md"), "no frontmatter here");
    await waitFor("the reload that observed the malformed package", () => reloads > reloadsBeforeMalformed);

    expect(installed().skills.has("valid-probe")).toBe(true);
    expect(installed().skills.has("broken-probe")).toBe(false);
  });

  it("keeps an installed skill when its SKILL.md is replaced with a malformed one", async () => {
    let reloads = 0;
    startWatcher(() => { reloads += 1 }, owned(ownedRoot));
    writeSkill(ownedRoot, "edited-probe", "Edited probe");
    await waitFor("the installed skill", () => installed().skills.has("edited-probe"));
    const reloadsBeforeEdit = reloads;
    const revisionBeforeEdit = installed().revision;

    // An editor saves SKILL.md in place, so a reload can observe it mid-write.
    writeFileSync(join(ownedRoot, "edited-probe", "SKILL.md"), "half-written, no frontmatter yet");
    await waitFor("the reload that observed the malformed edit", () => reloads > reloadsBeforeEdit);

    // The last complete revision keeps serving the package instead of losing it.
    expect(installed().skills.get("edited-probe")?.trigger).toBe("Edited probe");
    expect(installed().revision).toBe(revisionBeforeEdit);
  });

  it("watches a shared root that exists at start", async () => {
    mkdirSync(sharedRoot, { recursive: true });
    startWatcher(() => {}, [...owned(ownedRoot), { dir: sharedRoot, owned: false, reach: "global" }]);

    writeSkill(sharedRoot, "shared-probe", "Shared probe");
    await waitFor("the shared-root skill", () => installed().skills.has("shared-probe"));
  });

  it("coalesces a burst of file events into one reload", async () => {
    let reloads = 0;
    startWatcher(() => { reloads += 1 }, owned(ownedRoot));

    for (let i = 0; i < 5; i += 1) writeSkill(ownedRoot, `burst-${i}`, `Burst ${i}`);
    await waitFor("the last skill of the burst", () => installed().skills.has("burst-4"));

    // Exactly one reload is the common case, but the OS may split a burst across
    // notification batches; the invariant is that reloads are fewer than events.
    expect(reloads).toBeLessThan(5);
  });

  it("awaits each debounced reload callback before starting the next revision", async () => {
    const events: string[] = [];
    let calls = 0;
    let release: (() => void) | undefined;
    startWatcher(async () => {
      calls += 1;
      const call = calls;
      events.push(`callback-${call}-start`);
      if (call === 1) await new Promise<void>((resolve) => { release = resolve; });
      events.push(`callback-${call}-end`);
    }, owned(ownedRoot));

    writeSkill(ownedRoot, "ordered-probe", "Ordered probe");
    await waitFor("the callback to start", () => events.includes("callback-1-start"));
    expect(installed().skills.has("ordered-probe")).toBe(true);
    expect(events).toEqual(["callback-1-start"]);
    release?.();
    await waitFor("the callback to settle", () => events.includes("callback-1-end"));
    const secondStart = events.indexOf("callback-2-start");
    expect(secondStart === -1 || secondStart > events.indexOf("callback-1-end")).toBe(true);
  });

  it("stops reloading after dispose", async () => {
    let reloads = 0;
    startWatcher(() => { reloads += 1 }, owned(ownedRoot));

    writeSkill(ownedRoot, "before-dispose", "Before dispose");
    await waitFor("the pre-dispose skill", () => installed().skills.has("before-dispose"));
    const reloadsBeforeDispose = reloads;

    await watcher?.dispose();
    writeSkill(ownedRoot, "after-dispose", "After dispose");
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 10));

    expect(reloads).toBe(reloadsBeforeDispose);
    expect(installed().skills.has("after-dispose")).toBe(false);
  });

  it("keeps reloading installed packages while managed-skill reconciliation is refused", async () => {
    const requests: string[] = [];
    // A malformed proposal record: reconciliation would quarantine it, so its
    // survival proves the refused half never ran.
    const proposals = join(ownedRoot, ".operations", "proposals");
    mkdirSync(proposals, { recursive: true });
    const proposal = join(proposals, `${"d".repeat(64)}.json`);
    writeFileSync(proposal, "not a proposal record");

    startWatcher(() => {}, owned(ownedRoot), {
      admit: async (request) => {
        requests.push(request.operation);
        return { ok: false, missing: ["learning"], reason: "learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" };
      },
    });

    writeSkill(ownedRoot, "refused-probe", "Refused probe");
    await waitFor("the added skill", () => installed().skills.has("refused-probe"));

    expect(requests).toContain("global skill reconciliation");
    expect(existsSync(proposal)).toBe(true);
  });

  it("reconciles the global store on reload when managed-skill mutation is admitted", async () => {
    const requests: string[] = [];
    // The same malformed proposal record as the refused case: quarantining it is
    // the reconciliation half running, so its absence proves the admitted path.
    const proposals = join(ownedRoot, ".operations", "proposals");
    mkdirSync(proposals, { recursive: true });
    const proposal = join(proposals, `${"e".repeat(64)}.json`);
    writeFileSync(proposal, "not a proposal record");

    startWatcher(() => {}, owned(ownedRoot), {
      admit: async (request) => {
        requests.push(request.operation);
        return { ok: true, grant: { operation: request.operation, required: request.required, capabilities: ["skills", "learning"], moduleIds: ["skills", "learning"], requireWorkflowConfirmation: true, workflowsMode: "off", identity: "test" } };
      },
    });

    writeSkill(ownedRoot, "admitted-probe", "Admitted probe");
    await waitFor("the added skill", () => installed().skills.has("admitted-probe"));
    await waitFor("the quarantined proposal", () => !existsSync(proposal));

    expect(requests).toContain("global skill reconciliation");
  });
});
