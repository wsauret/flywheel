import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../../helpers/directories.js";
import {
  createDefinitionAssetReader,
  describeAsset,
  resolveAssetRef,
  type AssetLocation,
} from "../../../../src/workflows/definition-assets.js";
import { decodeAuthoredWorkflow, withLoadedContent } from "../../../../src/workflows/loader.js";
import { parseWorkflowYaml } from "../../../../src/infra/workflow-yaml.js";
import { workflowBriefs } from "../../../../src/workflows/brief.js";

const PROJECT: AssetLocation = { root: { kind: "directory", dir: "/scratch/project/workflows" }, path: "nested/flow.yaml" };
const CORE: AssetLocation = { root: { kind: "core" }, path: "debug.yaml" };

describe("resolveAssetRef", () => {
  it("resolves a relative path from the folder of the file that wrote it, in the same root", () => {
    expect(resolveAssetRef(PROJECT, "briefs/one.md")).toEqual({ root: PROJECT.root, path: "nested/briefs/one.md" });
    expect(resolveAssetRef(PROJECT, "../contracts/plan.json")).toEqual({ root: PROJECT.root, path: "contracts/plan.json" });
    expect(resolveAssetRef(CORE, "briefs/debug.fix.md")).toEqual({ root: { kind: "core" }, path: "briefs/debug.fix.md" });
  });

  it("resolves a bundled: path in the core root from any layer", () => {
    expect(resolveAssetRef(PROJECT, "bundled:briefs/debug.fix.md")).toEqual({ root: { kind: "core" }, path: "briefs/debug.fix.md" });
    expect(describeAsset({ root: { kind: "core" }, path: "briefs/debug.fix.md" })).toBe("bundled:briefs/debug.fix.md");
  });

  // Paths are POSIX on every platform, so a Windows path fails the same way
  // on macOS, Linux, and Windows instead of reading a different file.
  it.each([
    ["briefs\\one.md", "backslash"],
    ["C:/briefs/one.md", "drive prefix"],
    ["c:steps", "drive prefix"],
    ["/etc/one.md", "must be relative"],
    ["bundled:/briefs/one.md", "must be relative"],
    ["", "must not be empty"],
    ["bundled:", "must not be empty"],
  ])("rejects %j: %s", (ref, message) => {
    expect(() => resolveAssetRef(PROJECT, ref)).toThrow(message);
  });

  it("rejects a path that leaves the root of its layer", () => {
    expect(() => resolveAssetRef(PROJECT, "../../outside.md")).toThrow("leaves the root");
    expect(() => resolveAssetRef(CORE, "bundled:../src/secret.md")).toThrow("leaves the root");
  });

  it("rejects a path that names a folder", () => {
    expect(() => resolveAssetRef(PROJECT, "briefs/")).toThrow("does not name a file");
  });
});

const FAKE_MANIFEST = {
  "workflows/solo.yaml": [
    "id: solo",
    "name: Solo",
    "input: contracts/targets.json",
    "phases:",
    "  - phase: work",
    "    brief: Do the work.",
    "    output: contracts/result.json",
  ].join("\n"),
  "workflows/contracts/result.json": JSON.stringify({ summary: "What the work did.", fields: { result: { type: "string", description: "The result." } } }),
  "workflows/contracts/targets.json": JSON.stringify({ fields: { targets: { type: "list", max: 4, unique: "id", description: "The targets.", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } } } }),
  "agents/personas/other.md": "not a core file",
};

describe("createDefinitionAssetReader in manifest mode", () => {
  // The core directory does not exist, so any disk read would fail: every
  // value the reader returns therefore comes from the manifest.
  const reader = createDefinitionAssetReader(FAKE_MANIFEST, join("/scratch", "no-core-tree"));

  it("lists only the core files", () => {
    expect(reader.listCoreFiles()).toEqual(["contracts/result.json", "contracts/targets.json", "solo.yaml"]);
  });

  it("refuses a core file that the build did not embed, and never falls back to the disk", () => {
    expect(() => reader.read({ root: { kind: "core" }, path: "debug.yaml" })).toThrow("bundled:debug.yaml is not in this build");
  });

  it("loads a workflow with its inline brief and contract files from the manifest", () => {
    const solo = withLoadedContent(decodeAuthoredWorkflow(parseWorkflowYaml(reader.read({ root: { kind: "core" }, path: "solo.yaml" })).document), {
      reader, location: { root: { kind: "core" }, path: "solo.yaml" }, provenance: { id: "solo", layer: "bundled", filePath: "bundled:solo.yaml" },
    });
    expect(solo?.provenance?.filePath).toBe("bundled:solo.yaml");
    const work = solo && workflowBriefs(solo).get("work");
    expect(work?.briefId).toBe("solo.work");
    expect(work?.output.fields.map(({ key }) => key)).toContain("result");
    // The input contract file resolves from the workflow file, once, with
    // the briefs.
    expect(solo?.inputContract?.fields).toMatchObject([{ key: "targets", type: "list", max: 4, unique: "id" }]);
  });

  it("refuses an input contract that declares an output envelope key, and names the file", () => {
    const invalidReader = createDefinitionAssetReader({
      ...FAKE_MANIFEST,
      "workflows/contracts/targets.json": JSON.stringify({ summary: "Not an input key.", fields: {} }),
    }, join("/scratch", "no-core-tree"));
    expect(() => withLoadedContent(decodeAuthoredWorkflow(parseWorkflowYaml(invalidReader.read({ root: { kind: "core" }, path: "solo.yaml" })).document), {
      reader: invalidReader, location: { root: { kind: "core" }, path: "solo.yaml" }, provenance: { id: "solo", layer: "bundled", filePath: "bundled:solo.yaml" },
    })).toThrow(/Workflow "solo" input: bundled:contracts\/targets\.json: invalid input contract:\nsummary: /);
  });
});

describe("createDefinitionAssetReader in source mode", () => {
  const tempDir = temporaryDirectories();

  // A source run must accept exactly the core paths that the binary embeds,
  // so a definition that loads in development also loads in a release.
  function sourceReader() {
    const coreDir = tempDir("flywheel-core-assets-");
    mkdirSync(join(coreDir, "contracts"));
    writeFileSync(join(coreDir, "contracts", "Result.json"), JSON.stringify({ summary: "The result." }));
    writeFileSync(join(coreDir, "solo.yaml"), "id: solo\n");
    writeFileSync(join(coreDir, "notes.txt"), "not a definition file");
    writeFileSync(join(coreDir, "contracts", ".DS_Store"), "");
    return createDefinitionAssetReader({}, coreDir);
  }

  it("lists only the file types that the build embeds", () => {
    expect(sourceReader().listCoreFiles()).toEqual(["contracts/Result.json", "solo.yaml"]);
  });

  it("refuses a core path that differs from a listed file only in case, as the binary does", () => {
    const reader = sourceReader();
    expect(reader.read({ root: { kind: "core" }, path: "contracts/Result.json" })).toContain("The result.");
    expect(() => reader.read({ root: { kind: "core" }, path: "contracts/result.json" })).toThrow("bundled:contracts/result.json is not in this build");
  });

  it("refuses a core file of a type that the build does not embed", () => {
    expect(() => sourceReader().read({ root: { kind: "core" }, path: "notes.txt" })).toThrow("bundled:notes.txt is not in this build");
  });
});
