import { Schema } from "effect";
import type { DefinitionLayer } from "../infra/definition-resolution.js";

/** Where a definition came from: one of the registry's layers, or `session`
 *  for a workflow file that a chat agent wrote in its own session scratch and
 *  launched by path. A session definition never enters the registry; its
 *  `filePath` is the resolved scratch path at launch. A row written before
 *  the session source existed names a registry layer and reads unchanged. */
type DefinitionSourceLayer = DefinitionLayer | "session";

// The loaded definition carries its provenance, and a compilation records the
// same value in `definition.loaded` facts. The interface derives from these
// fields so the two cannot drift apart.
const DefinitionProvenanceFields = {
  layer: Schema.Literals(["bundled", "user", "project", "session"] satisfies readonly DefinitionSourceLayer[]),
  filePath: Schema.String,
  id: Schema.String,
  /** The module definition bundle a bundled file came from, by contribution
   *  id. Availability requires that module for the definition (ARCH-STRUCTURE-031). A
   *  row written before bundles existed has no bundle and reads unchanged. */
  bundle: Schema.optionalKey(Schema.String),
};

export interface DefinitionProvenance extends Schema.Struct.Type<typeof DefinitionProvenanceFields> {
  readonly shadowedSource?: DefinitionProvenance;
}

export const DefinitionProvenanceSchema: Schema.Codec<DefinitionProvenance> = Schema.suspend((): Schema.Codec<DefinitionProvenance> =>
  Schema.Struct({ ...DefinitionProvenanceFields, shadowedSource: Schema.optionalKey(DefinitionProvenanceSchema) }),
);

export interface DefinitionError {
  file: string;
  message: string;
  layer?: DefinitionSourceLayer;
  id?: string;
  shadowedSource?: DefinitionProvenance;
}

export function formatDefinitionError(error: DefinitionError): string {
  const parts = [
    error.layer ? `[${error.layer}]` : "",
    error.file,
    error.id ? `(${error.id})` : "",
  ].filter(Boolean);
  const shadowed = error.shadowedSource
    ? `; shadows ${error.shadowedSource.layer}:${error.shadowedSource.filePath}`
    : "";
  return `${parts.join(" ")}: ${error.message}${shadowed}`;
}
