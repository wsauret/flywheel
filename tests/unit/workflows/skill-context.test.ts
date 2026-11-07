import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContainedDirectoryContract } from "../../../src/infra/descriptor-directory-contract.js";
import type { SkillDirectoryEntry } from "../../../src/workflows/skill-context.js";
import {
  readSkillPackage,
  readSkillPackageFiles,
  readSkillResource,
  renderSkillClosure,
  renderSkillContext,
  withSkillRoot,
} from "../../../src/workflows/skill-context.js";
import type { SkillDefinition, SkillPackageBinding } from "../../../src/workflows/skill-schema.js";
import { publishSkillRevision, SKILL_LIMITS } from "../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions } from "../../../src/workflows/skills.js";

const TMP = join(tmpdir(), "flywheel-skill-context-test");
const ROOT = join(TMP, "skills");
const PACKAGE_DIR = join(ROOT, "pdf-processing");
const SKILL_MD = "---\ndescription: Process PDF files\n---\nRead the PDF.";

function loadFixture(): SkillDefinition {
  const skill = loadSkillDefinitions({ roots: [{ authority: "external", dir: ROOT, reach: "project" }] }).skills.get("pdf-processing");
  if (!skill) throw new Error("fixture skill failed to load");
  return skill;
}

function bindPackage(name: string): SkillPackageBinding {
  return withSkillRoot(ROOT, (root) => {
    const binding = root.bindPackage(name);
    if (!binding) throw new Error(`fixture package "${name}" is not installed`);
    return binding;
  });
}

function bindFixture(): SkillPackageBinding {
  return bindPackage("pdf-processing");
}

function writePackage(root: string, name: string, skillFile: string, resource = "API notes"): void {
  const packageDir = join(root, name);
  mkdirSync(join(packageDir, "references"), { recursive: true });
  writeFileSync(join(packageDir, "SKILL.md"), skillFile);
  writeFileSync(join(packageDir, "references", "api.md"), resource);
}

function entriesOf(directory: ContainedDirectoryContract): readonly SkillDirectoryEntry[] {
  return directory.entryNames().map((name) => ({ name, type: name === "references" ? "directory" : "file" }));
}

beforeEach(() => {
  mkdirSync(join(PACKAGE_DIR, "references"), { recursive: true });
  writeFileSync(join(PACKAGE_DIR, "SKILL.md"), SKILL_MD);
  writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "API notes");
  writeFileSync(join(TMP, "secret.txt"), "secret");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("renderSkillContext", () => {
  it("is identical for bundled filesystem and manifest packaging", () => {
    const filesystem = loadSkillDefinitions({
      roots: [{ authority: "bundled", dir: ROOT, reach: "global", sourceKind: "agent" }],
      bundledEntries: [],
    }).skills.get("pdf-processing");
    const manifest = loadSkillDefinitions({
      roots: [],
      bundledEntries: [
        ["pdf-processing/SKILL.md", SKILL_MD],
        ["pdf-processing/references/api.md", "API notes"],
      ],
    }).skills.get("pdf-processing");
    if (!filesystem || !manifest) throw new Error("bundled fixture skill failed to load");

    expect(renderSkillContext(filesystem)).toBe(renderSkillContext(manifest));
  });

  it("states how much of the body budget a writable package uses, so a writer can plan before it writes", () => {
    const dir = join(TMP, "budgeted");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\ndescription: "Use for budgeted work."\nmanaged: flywheel\n---\n${"word ".repeat(200)}`);
    const skill = loadSkillDefinitions({ roots: [{ authority: "external", dir: TMP, reach: "project" }] }).skills.get("budgeted");
    if (!skill) throw new Error("fixture skill failed to load");

    expect(renderSkillContext(skill)).toMatch(/body: \d+% - [\d,]+\/[\d,]+ chars/u);
    // Well under the limit: usage only, no instruction to act on.
    expect(renderSkillContext(skill)).not.toContain("near its limit");
  });

  it("names the move to make when a body is near its limit, so a writer does not just compress to fit", () => {
    const dir = join(TMP, "crowded");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\ndescription: "Use for crowded work."\nmanaged: flywheel\n---\n${"word ".repeat(2_200)}`);
    const skill = loadSkillDefinitions({ roots: [{ authority: "external", dir: TMP, reach: "project" }] }).skills.get("crowded");
    if (!skill) throw new Error("fixture skill failed to load");

    const rendered = renderSkillContext(skill);
    expect(rendered).toContain("near its limit");
    expect(rendered).toContain("references/<topic>.md");
    expect(rendered).toContain("Do not compress what you are about to write");
  });

  it("omits the body budget for a bundled package, which no writer can change", () => {
    const skill = loadSkillDefinitions({
      roots: [{ authority: "bundled", dir: ROOT, reach: "global", sourceKind: "agent" }],
      bundledEntries: [],
    }).skills.get("pdf-processing");
    if (!skill) throw new Error("bundled fixture skill failed to load");

    expect(renderSkillContext(skill)).not.toContain("body:");
  });

  describe("capability markers", () => {
    const CONDITIONED_MD = [
      "---",
      "description: Use for conditioned work.",
      "---",
      "Always do this.",
      "{{if:bash}}",
      "Run the probe script.",
      "{{else}}",
      "Settle it with your tools.",
      "{{end}}",
      "{{if:subagent}}",
      "{{ref:reviewer-protocol}}",
      "{{end}}",
    ].join("\n");
    const REFERENCE_LINE = "dispatch every chosen reviewer in parallel through multiple `subagent` calls";

    function conditioned(authority: "bundled" | "external"): SkillDefinition {
      const skill = authority === "bundled"
        ? loadSkillDefinitions({ roots: [], bundledEntries: [["conditioned/SKILL.md", CONDITIONED_MD], ["conditioned/references/api.md", "{{if:bash}}\nraw\n{{end}}\n"]] }).skills.get("conditioned")
        : (() => {
          writePackage(ROOT, "conditioned", CONDITIONED_MD);
          return loadSkillDefinitions({ roots: [{ authority: "external", dir: ROOT, reach: "project" }] }).skills.get("conditioned");
        })();
      if (!skill) throw new Error("conditioned fixture skill failed to load");
      return skill;
    }

    it("renders a bundled body for its reader after expanding references, and names each tested term", () => {
      const skill = conditioned("bundled");

      const off = renderSkillContext(skill, () => false);
      expect(off).toContain("conditions: bash=off subagent=off");
      expect(off).toContain("Always do this.\nSettle it with your tools.");
      expect(off).not.toContain("Run the probe script.");
      expect(off).not.toContain(REFERENCE_LINE);
      expect(off).not.toContain("{{");

      const on = renderSkillContext(skill, () => true);
      expect(on).toContain("conditions: bash=on subagent=on");
      expect(on).toContain("Always do this.\nRun the probe script.");
      expect(on).toContain(REFERENCE_LINE);
      expect(on).not.toContain("Settle it with your tools.");
    });

    it("refuses to compose a package that dispatches agents for a reader that cannot call the subagent tool", () => {
      const revision = publishSkillRevision(1, loadSkillDefinitions({ roots: [], bundledEntries: [
        ["dispatching/SKILL.md", "---\ndescription: Use for dispatching work.\nagents:\n  - advisor\n---\nDispatch the advisor."],
        ["wrapper/SKILL.md", "---\ndescription: Use for wrapped work.\ndependencies:\n  - dispatching\n---\nWrap it."],
      ] }).skills);

      expect(() => renderSkillClosure(["wrapper"], revision, 'Persona "reader"', (term) => term !== "subagent"))
        .toThrow('Persona "reader" composes skill "dispatching", which dispatches agents, and the agent that reads it cannot call the subagent tool');
      expect(renderSkillClosure(["wrapper"], revision, 'Persona "reader"', () => true).join("\n")).toContain("Dispatch the advisor.");
    });

    it("keeps the markers as written in the identity form that carries no check", () => {
      const identity = renderSkillContext(conditioned("bundled"));

      expect(identity).toContain("{{if:bash}}\nRun the probe script.\n{{else}}");
      expect(identity).not.toContain("conditions:");
    });

    it("leaves an external body and a bundled resource byte for byte", () => {
      const external = renderSkillContext(conditioned("external"), () => false);
      expect(external).toContain("{{if:bash}}\nRun the probe script.\n{{else}}");
      expect(external).toContain("{{ref:reviewer-protocol}}");
      expect(external).not.toContain("conditions:");

      expect(readSkillResource(conditioned("bundled"), "references/api.md", 0, 1_000).content).toBe("{{if:bash}}\nraw\n{{end}}\n");
    });
  });
});

describe("readSkillResource", () => {
  const WINDOW = 64_000;

  it("reads a declared package resource", () => {
    expect(readSkillResource(loadFixture(), "references/api.md", 0, WINDOW)).toEqual({ content: "API notes", endOffset: 9, totalBytes: 9 });
  });

  it("rejects paths the package never declared", () => {
    const skill = loadFixture();

    for (const path of ["../secret.txt", "references/../../secret.txt", join(TMP, "secret.txt"), "SKILL.md"]) {
      expect(() => readSkillResource(skill, path, 0, WINDOW)).toThrow("does not declare resource");
    }
  });

  it("rejects a declared file that became a symlink out of the package", () => {
    const skill = loadFixture();
    unlinkSync(join(PACKAGE_DIR, "references", "api.md"));
    symlinkSync(join(TMP, "secret.txt"), join(PACKAGE_DIR, "references", "api.md"));

    expect(() => readSkillResource(skill, "references/api.md", 0, WINDOW)).toThrow("escapes its package");
  });

  it("bounds the read by the size on disk, not the size declared at discovery", () => {
    const skill = loadFixture();
    expect(skill.resources).toEqual([{ path: "references/api.md", bytes: 9 }]);
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "g".repeat(500_000));

    const read = readSkillResource(skill, "references/api.md", 0, WINDOW);

    expect(read.content).toBe("g".repeat(WINDOW));
    expect(read.totalBytes).toBe(500_000);
  });

  it("pages a resource larger than one window without gaps or overlap", () => {
    const skill = loadFixture();
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), `${"a".repeat(WINDOW)}tail`);

    const first = readSkillResource(skill, "references/api.md", 0, WINDOW);
    const second = readSkillResource(skill, "references/api.md", WINDOW, WINDOW);

    expect(first.content).toBe("a".repeat(WINDOW));
    expect(second.content).toBe("tail");
    expect(second.totalBytes).toBe(WINDOW + 4);
  });

  it("never splits a multi-byte character across two windows", () => {
    const skill = loadFixture();
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "é".repeat(4));

    const first = readSkillResource(skill, "references/api.md", 0, 3);
    const second = readSkillResource(skill, "references/api.md", first.endOffset, 3);

    expect(first.content).toBe("é");
    expect(second.content).toBe("é");
    expect(first.endOffset).toBe(2);
    expect(first.totalBytes).toBe(8);
  });

  it("refuses an offset that is not on a character boundary", () => {
    const skill = loadFixture();
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "é".repeat(4));

    expect(() => readSkillResource(skill, "references/api.md", 1, WINDOW)).toThrow("inside a character");
    expect(() => readSkillResource(skill, "references/api.md", 9, WINDOW)).toThrow("past its 8 bytes");
  });

  it("refuses a resource that is not UTF-8 text instead of decoding it lossily", () => {
    const skill = loadFixture();
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), Buffer.from([0x41, 0xff, 0xfe, 0x42]));

    expect(() => readSkillResource(skill, "references/api.md", 0, WINDOW)).toThrow("not valid UTF-8");
  });

  it("refuses a resource that ends inside a character instead of trimming it away", () => {
    const skill = loadFixture();
    // The last character is cut short at EOF: trimming it would report a clean
    // read of bytes the resource does not contain, and name no next offset.
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), Buffer.from([0x41, 0xc3]));

    expect(() => readSkillResource(skill, "references/api.md", 0, WINDOW)).toThrow("not valid UTF-8");
  });

  it("refuses a read when the package directory was replaced after load", () => {
    const skill = loadFixture();
    const decoy = join(TMP, "decoy");
    mkdirSync(join(decoy, "references"), { recursive: true });
    writeFileSync(join(decoy, "references", "api.md"), "DECOY");

    // Another real directory under the same name: same path, new identity.
    renameSync(PACKAGE_DIR, join(TMP, "moved-package"));
    mkdirSync(join(PACKAGE_DIR, "references"), { recursive: true });
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "DECOY");
    expect(() => readSkillResource(skill, "references/api.md", 0, WINDOW)).toThrow("escapes its package");

    // And a symlink to another tree under the same name.
    rmSync(PACKAGE_DIR, { recursive: true, force: true });
    symlinkSync(decoy, PACKAGE_DIR);
    expect(() => readSkillResource(skill, "references/api.md", 0, WINDOW)).toThrow("escapes its package");
  });

  it("refuses a read when an intermediate directory became a symlink after load", () => {
    const skill = loadFixture();
    const outside = join(TMP, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "api.md"), "OUTSIDE");
    renameSync(join(PACKAGE_DIR, "references"), join(TMP, "moved-references"));
    symlinkSync(outside, join(PACKAGE_DIR, "references"));

    expect(() => readSkillResource(skill, "references/api.md", 0, WINDOW)).toThrow("escapes its package");
  });

  it("reads a bundled resource from the compiled manifest", () => {
    const skills = loadSkillDefinitions({
      roots: [],
      bundledEntries: [
        ["pdf-processing/SKILL.md", SKILL_MD],
        ["pdf-processing/references/api.md", "Bundled API notes"],
      ],
    }).skills;
    const skill = skills.get("pdf-processing");
    if (!skill) throw new Error("bundled fixture skill failed to load");

    expect(skill.resources).toEqual([{ path: "references/api.md", bytes: 17 }]);
    expect(readSkillResource(skill, "references/api.md", 0, WINDOW).content).toBe("Bundled API notes");
  });
});

describe("skill root containment and selection", () => {
  it("lists a symlink package as a candidate and binds it to its target", () => {
    const linked = join(TMP, "linked-package");
    writePackage(linked, "contents", SKILL_MD);
    symlinkSync(linked, join(ROOT, "linked-package"));

    const candidates = withSkillRoot(ROOT, (root) => root.listPackageDirs(SKILL_LIMITS.packages));
    expect(candidates).toEqual(["linked-package", "pdf-processing"]);
    expect(withSkillRoot(ROOT, (root) => root.bindPackage("linked-package"))).toMatchObject({ canonicalDir: realpathSync(linked), linked: true });
  });

  it("bounds root listing even when every examined entry is skipped", () => {
    let examined = 0;
    function* skippedEntries(_directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      for (;;) {
        examined++;
        yield { name: `metadata-${examined}`, type: "file" };
      }
    }

    expect(() => withSkillRoot(ROOT, (root) => root.listPackageDirs(1), skippedEntries)).toThrow(`more than ${SKILL_LIMITS.scanEntries} entries`);
    expect(examined).toBe(SKILL_LIMITS.scanEntries + 1);
  });

  it("refuses a root that is replaced after its descriptor listing", () => {
    const decoy = join(TMP, "decoy-root");
    mkdirSync(decoy, { recursive: true });
    let replaced = false;
    function* replaceRoot(_directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      if (!replaced) {
        replaced = true;
        renameSync(ROOT, join(TMP, "moved-root"));
        symlinkSync(decoy, ROOT);
      }
      yield { name: "pdf-processing", type: "directory" };
    }

    expect(() => withSkillRoot(ROOT, (root) => root.listPackageDirs(1), replaceRoot)).toThrow("skill root changed");
  });

  it("selects the first root and records the lower-precedence package identity", () => {
    const projectRoot = join(TMP, "project-skills");
    const userRoot = join(TMP, "user-skills");
    writePackage(projectRoot, "duplicate", "---\ndescription: Project winner\n---\nProject body.", "project notes");
    writePackage(userRoot, "duplicate", "---\ndescription: User loser\n---\nUser body.", "user notes");

    const lower = loadSkillDefinitions({ roots: [{ authority: "external", dir: userRoot, reach: "global" }] }).skills.get("duplicate");
    const load = loadSkillDefinitions({
      roots: [
        { authority: "external", dir: projectRoot, reach: "project" },
        { authority: "external", dir: userRoot, reach: "global" },
      ],
    });
    const selected = load.skills.get("duplicate");
    if (!selected || !lower) throw new Error("duplicate fixture skill failed to load");

    expect(selected.trigger).toBe("Project winner");
    expect(selected.body).toBe("Project body.");
    expect(selected.shadowed?.packageIdentity).toEqual(lower.packageIdentity);
    expect(load.resolutions.find(({ id }) => id === "duplicate")?.candidates.map(({ source }) => source.layer)).toEqual(["project", "user"]);
  });

  it("changes the package identity when a declared resource changes", () => {
    const first = loadFixture();
    expect(loadFixture().packageIdentity).toEqual(first.packageIdentity);

    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "rewritten API notes");
    const second = loadFixture();

    expect(second.packageIdentity.sha256).not.toBe(first.packageIdentity.sha256);
    expect(second.packageIdentity.bytes).toBe(Buffer.byteLength(SKILL_MD) + Buffer.byteLength("rewritten API notes"));
  });
});

describe("readSkillPackage", () => {
  it("takes the SKILL.md file and the resource manifest from one package directory", () => {
    const snapshot = readSkillPackage(bindFixture(), "external");

    expect(snapshot?.skillFile).toBe(SKILL_MD);
    expect(snapshot?.resources).toEqual([{ path: "references/api.md", bytes: 9 }]);
  });

  it("reports a directory that holds no SKILL.md as no package at all", () => {
    mkdirSync(join(ROOT, "not-a-package"), { recursive: true });

    expect(readSkillPackage(bindPackage("not-a-package"), "external")).toBeUndefined();
  });

  it("refuses the snapshot when the package directory is replaced while its resources are walked", () => {
    const binding = bindFixture();
    const decoy = join(TMP, "decoy");
    mkdirSync(join(decoy, "references"), { recursive: true });
    writeFileSync(join(decoy, "SKILL.md"), "---\ndescription: Decoy\n---\nDecoy body.");
    writeFileSync(join(decoy, "references", "decoy.md"), "decoy");

    // The body is already read, and the walk is descriptor-rooted: publishing
    // it beside another directory's file list would advertise resources the
    // loaded package never held.
    let replaced = false;
    function* replaceThenWalk(directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      if (!replaced) {
        replaced = true;
        renameSync(PACKAGE_DIR, join(TMP, "moved-package"));
        symlinkSync(decoy, PACKAGE_DIR);
      }
      yield* entriesOf(directory);
    }

    expect(() => readSkillPackage(binding, "external", replaceThenWalk)).toThrow("escapes its package");
  });

  it("stops examining a package directory at the scan bound, whatever the entries are", () => {
    let examined = 0;
    function* endlessSkippedEntries(_directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      for (;;) {
        examined++;
        yield { name: `skipped-${examined}`, type: "symlink" };
      }
    }

    expect(() => readSkillPackage(bindFixture(), "external", endlessSkippedEntries)).toThrow("entries");
    expect(examined).toBe(SKILL_LIMITS.scanEntries + 1);
  });

  it("refuses the package when its SKILL.md is rewritten while the resources are walked", () => {
    const binding = bindFixture();

    // An editor saving in place mid-load: the body was already read, so a
    // published snapshot would pair one revision's procedure with the file
    // list of another.
    function* rewriteThenWalk(directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      writeFileSync(join(PACKAGE_DIR, "SKILL.md"), "---\ndescription: Process PDF files\n---\nEdited body.");
      yield* entriesOf(directory);
    }

    expect(() => readSkillPackage(binding, "external", rewriteThenWalk)).toThrow("SKILL.md changed while the package was read");
  });

  it("refuses the package when a declared resource changes after the walk measured it", () => {
    const binding = bindFixture();

    function* walkThenEditResource(directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      yield* entriesOf(directory);
      writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "API notes, rewritten and longer");
    }

    expect(() => readSkillPackage(binding, "external", walkThenEditResource)).toThrow("references/api.md changed while the package was read");
  });

  it("caps the SKILL.md of an external package by file and a bundled one by the package total alone", () => {
    const oversized = SKILL_LIMITS.metadataBytes + SKILL_LIMITS.bodyBytes + 1;
    writeFileSync(join(PACKAGE_DIR, "SKILL.md"), `---\ndescription: Process PDF files\n---\n${"x".repeat(oversized)}`);

    expect(() => readSkillPackage(bindFixture(), "external")).toThrow("over the");
    expect(readSkillPackage(bindFixture(), "bundled")?.resources).toEqual([{ path: "references/api.md", bytes: 9 }]);
  });
});

describe("readSkillPackageFiles", () => {
  it("takes every admitted file of one package directory as text", () => {
    expect(readSkillPackageFiles(bindFixture(), "external")).toEqual(new Map([
      ["SKILL.md", SKILL_MD],
      ["references/api.md", "API notes"],
    ]));
  });

  it("never declares hidden entries, so OS metadata cannot refuse a package", () => {
    // macOS drops binary .DS_Store files into any browsed directory; one of
    // them skipped a whole installed skill in production.
    writeFileSync(join(PACKAGE_DIR, ".DS_Store"), Buffer.from([0x00, 0x80, 0xff, 0x01]));
    writeFileSync(join(PACKAGE_DIR, "references", ".DS_Store"), Buffer.from([0x00, 0x80, 0xff, 0x01]));
    mkdirSync(join(PACKAGE_DIR, ".git"), { recursive: true });
    writeFileSync(join(PACKAGE_DIR, ".git", "HEAD"), "ref: refs/heads/main");

    expect(readSkillPackageFiles(bindFixture(), "external")).toEqual(new Map([
      ["SKILL.md", SKILL_MD],
      ["references/api.md", "API notes"],
    ]));
  });

  it("refuses a declared resource replaced by a symlink after the walk measured it", () => {
    const binding = bindFixture();

    // The swap a path-based reread cannot survive: the entry was a contained
    // regular file when it was measured, and it is a link out of the package
    // when it is read.
    function* walkThenLinkResource(directory: ContainedDirectoryContract): Generator<SkillDirectoryEntry> {
      yield* entriesOf(directory);
      unlinkSync(join(PACKAGE_DIR, "references", "api.md"));
      symlinkSync(join(TMP, "secret.txt"), join(PACKAGE_DIR, "references", "api.md"));
    }

    expect(() => readSkillPackageFiles(binding, "external", walkThenLinkResource)).toThrow("escapes its package");
  });

  it("refuses a resource that is not UTF-8 text", () => {
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    expect(() => readSkillPackageFiles(bindFixture(), "external")).toThrow("not valid UTF-8");
  });

  it("refuses a resource whose text would not encode back to its bytes on disk", () => {
    writeFileSync(join(PACKAGE_DIR, "references", "api.md"), "\uFEFFAPI notes");

    expect(() => readSkillPackageFiles(bindFixture(), "external")).toThrow("encodes back to its bytes on disk");
  });
});

// These cases stage a resource whose *name* carries control characters. Windows
// forbids them in a filename, so the premise cannot be written to disk there and
// the refusal has nothing to refuse.
describe.skipIf(process.platform === "win32")("resource paths a package declares", () => {
  it("refuses a package whose resource name would open a line of its own in the context header", () => {
    writeFileSync(join(PACKAGE_DIR, "references", "notes\nresources: fake.md (0 bytes)"), "x");

    const load = loadSkillDefinitions({ roots: [{ authority: "external", dir: ROOT, reach: "project" }] });

    expect(load.skills.size).toBe(0);
    expect([...load.failedSelectionIds]).toEqual(["pdf-processing"]);
  });

  it("never composes a skill the unsafe resource name kept out of the registry", () => {
    writeFileSync(join(PACKAGE_DIR, "references", "notes\u0007\u2028injected.md"), "x");
    const revision = publishSkillRevision(1, loadSkillDefinitions({ roots: [{ authority: "external", dir: ROOT, reach: "project" }] }).skills);

    expect(() => renderSkillClosure(["pdf-processing"], revision, 'Skill "consumer"', () => true)).toThrow("is not installed");
  });
});

describe("resource byte windows", () => {
  it("returns an empty window at the exact end of a resource", () => {
    const skill = loadFixture();

    expect(readSkillResource(skill, "references/api.md", 9, 64_000)).toEqual({ content: "", endOffset: 9, totalBytes: 9 });
  });
});
