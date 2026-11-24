import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  definitionAssets,
  describeAsset,
  resolveAssetRef,
  type AssetLocation,
  type DefinitionAssetReader,
} from "../../../../src/workflows/definitions/definition-assets.js";
import { workflowAssets } from "../../../../src/workflows/provenance/asset-manifest.js";
import { withLoadedContent } from "../../../../src/workflows/definitions/loader.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/schema/workflow-schema.js";
import { parseWorkflowYaml } from "../../../../src/infra/yaml/workflow-yaml.js";

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

describe("the definition assets of a compiled binary", () => {
  const embedded = { ...FAKE_MANIFEST, "workflows/notes.txt": "not a definition file" };
  let reader: DefinitionAssetReader;

  // A compiled binary loads the module once, after the build filled the
  // manifest. A fresh instance of the module does the same here.
  beforeAll(async () => {
    Object.assign(workflowAssets, embedded);
    const binary: typeof import("../../../../src/workflows/definitions/definition-assets.js") = await import(`../../../../src/workflows/definitions/definition-assets.js?manifest=${crypto.randomUUID()}`);
    reader = binary.definitionAssets;
  });

  afterAll(() => {
    for (const key of Object.keys(embedded)) Reflect.deleteProperty(workflowAssets, key);
  });

  it("lists only the core files of the definition file types", () => {
    expect(reader.listCoreFiles()).toEqual(["contracts/result.json", "contracts/targets.json", "solo.yaml"]);
  });

  it("refuses a core file that the build did not embed, and never falls back to the disk", () => {
    expect(() => reader.read({ root: { kind: "core" }, path: "debug.yaml" })).toThrow("bundled:debug.yaml is not in this build");
    // The source tree holds this file, but the build did not embed it.
    expect(definitionAssets.listCoreFiles()).toContain("contracts/implementation-plan.json");
    expect(() => reader.read({ root: { kind: "core" }, path: "contracts/implementation-plan.json" })).toThrow("bundled:contracts/implementation-plan.json is not in this build");
  });

  it("refuses a core file of a type that the build does not embed", () => {
    expect(() => reader.read({ root: { kind: "core" }, path: "notes.txt" })).toThrow("bundled:notes.txt is not in this build");
  });

  it("loads a workflow with its inline brief and contract files from the manifest", () => {
    const solo = withLoadedContent(Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })(parseWorkflowYaml(reader.read({ root: { kind: "core" }, path: "solo.yaml" })).document), {
      reader, location: { root: { kind: "core" }, path: "solo.yaml" }, provenance: { id: "solo", layer: "bundled", filePath: "bundled:solo.yaml" },
    });
    expect(solo.provenance.filePath).toBe("bundled:solo.yaml");
    const work = solo.briefs.get("work");
    expect(work?.briefId).toBe("solo.work");
    expect(work?.output.fields.map(({ key }) => key)).toContain("result");
    // The input contract file resolves from the workflow file, once, with
    // the briefs.
    expect(solo.inputContract?.fields).toMatchObject([{ key: "targets", type: "list", max: 4, unique: "id" }]);
  });

  it("refuses an input contract that declares an output envelope key, and names the file", () => {
    workflowAssets["workflows/contracts/targets.json"] = JSON.stringify({ summary: "Not an input key.", fields: {} });
    try {
      expect(() => withLoadedContent(Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })(parseWorkflowYaml(reader.read({ root: { kind: "core" }, path: "solo.yaml" })).document), {
        reader, location: { root: { kind: "core" }, path: "solo.yaml" }, provenance: { id: "solo", layer: "bundled", filePath: "bundled:solo.yaml" },
      })).toThrow(/Workflow "solo" input: bundled:contracts\/targets\.json: invalid input contract:\nsummary: /);
    } finally {
      workflowAssets["workflows/contracts/targets.json"] = embedded["workflows/contracts/targets.json"];
    }
  });
});

// A source run must accept exactly the core paths that the binary embeds,
// so a definition that loads in development also loads in a release.
describe("the definition assets of a source run", () => {
  it("refuses a core path that differs from a listed file only in case, as the binary does", () => {
    const source = readFileSync(join(import.meta.dir, "../../../../src/workflows/workflows/contracts/implementation-plan.json"), "utf8");
    expect(definitionAssets.read({ root: { kind: "core" }, path: "contracts/implementation-plan.json" })).toBe(source);
    expect(() => definitionAssets.read({ root: { kind: "core" }, path: "contracts/Implementation-plan.json" })).toThrow("bundled:contracts/Implementation-plan.json is not in this build");
  });
});
