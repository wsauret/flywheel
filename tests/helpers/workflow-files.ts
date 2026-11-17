import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DefinitionLayer } from "../../src/infra/definition-resolution.js";
import { DefinitionProvenanceSchema, type DefinitionError, type DefinitionProvenance } from "../../src/workflows/definition-provenance.js";
import { definitionAssets, type DefinitionAssetReader, type AssetLocation } from "../../src/workflows/definition-assets.js";
import { decodeWorkflowFile, type DecodedWorkflowFile } from "../../src/workflows/workflow-file.js";
import { withLoadedContent } from "../../src/workflows/loader.js";
import type { SkillRegistryRevision } from "../../src/workflows/skill-schema.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../src/workflows/workflow-schema.js";
import { stepGrammarWarning } from "../../src/workflows/retired-step-grammar/convert.js";

/** Loads explicit fixture files without a production definition catalog or layer merge. */
export function loadWorkflowFiles(entries: Iterable<{ file: string; location: AssetLocation; content: string }>, layer: DefinitionLayer = "project", bundle?: string, reader: DefinitionAssetReader = definitionAssets, skills?: SkillRegistryRevision) {
  const results = new Map<string, WorkflowDefinition>();
  const decoded = new Map<string, DecodedWorkflowFile>();
  const errors: DefinitionError[] = [];
  const warnings: DefinitionError[] = [];
  for (const { file, location, content } of entries) {
    const result = decodeWorkflowFile({ file, content, ...(skills ? { skills } : {}) });
    if (!result.ok) {
      errors.push(...result.diagnostics.map(({ keyPath, message }) => ({ file, layer, message: keyPath === "(root)" ? message : `${keyPath}: ${message}` })));
      continue;
    }
    decoded.set(result.definition.id, result);
    if (result.stepGrammar) warnings.push({ file, layer, id: result.definition.id, message: stepGrammarWarning(result.stepGrammar.notes) });
    try {
      results.set(result.definition.id, withLoadedContent(result.definition, {
        location, reader,
        provenance: { filePath: file, layer, id: result.definition.id, ...(bundle ? { bundle } : {}) },
        ...(result.stepGrammar ? { stepGrammar: result.stepGrammar.view } : {}),
      }));
    } catch (error) {
      errors.push({ file, layer, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, decoded, errors, warnings };
}

/** Reads the YAML fixture files of one test-owned folder. No precedence or registration applies. */
export function loadWorkflowDefinitions(dir: string, layer: DefinitionLayer = "project", bundle?: string, reader: DefinitionAssetReader = definitionAssets, skills?: SkillRegistryRevision) {
  return loadWorkflowFiles(readdirSync(dir).filter((name) => /\.ya?ml$/u.test(name)).sort().map((path) => ({
    file: join(dir, path), location: { root: { kind: "directory" as const, dir }, path }, content: readFileSync(join(dir, path), "utf8"),
  })), layer, bundle, reader, skills);
}

/** Decodes one authored workflow document and loads its inline briefs and
 *  input contract as the loader does for a file with no location. A
 *  `provenance` on the document or in the argument names the file;
 *  otherwise it is a project file named after the workflow. */
export function loadedWorkflow(document: unknown, provenance?: Partial<DefinitionProvenance>): WorkflowDefinition {
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(document);
  const { provenance: stated } = Schema.decodeUnknownSync(StatedProvenanceSchema)(document);
  return withLoadedContent(definition, {
    location: undefined,
    reader: definitionAssets,
    provenance: { layer: "project", filePath: `${definition.id}.workflow.yaml`, id: definition.id, ...stated, ...provenance },
  });
}

const StatedProvenanceSchema = Schema.Struct({ provenance: Schema.optionalKey(DefinitionProvenanceSchema) });
