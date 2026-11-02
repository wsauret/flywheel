import { Schema } from "effect";
import { parseFrontmatter } from "../../infra/frontmatter.js";
import type { PersonaMetadataIndex } from "./persona-schema.js";
import { loadPersonaSources } from "./persona-sources.js";

const PersonaMetadataSchema = Schema.Struct({ name: Schema.String, role: Schema.NonEmptyString });
let cachedIndex: PersonaMetadataIndex | undefined;

function ensurePersonaIndex(): PersonaMetadataIndex {
  if (cachedIndex) return cachedIndex;
  const index: PersonaMetadataIndex = {};
  // Persona files are Flywheel-authored: a missing/invalid frontmatter is a producer
  // bug, not a tolerable variation. Throw with the offending file rather than skipping.
  for (const [file, content] of Object.entries(loadPersonaSources())) {
    const parsed = parseFrontmatter(content);
    if (!parsed) throw new Error(`Persona ${file} is missing frontmatter`);
    const definition = Schema.decodeUnknownSync(PersonaMetadataSchema)(parsed.frontmatter);
    index[definition.name] = { name: definition.name, role: definition.role };
  }
  cachedIndex = index;
  return index;
}

export function discoverAgentRoles(): ReadonlySet<string> {
  const index = ensurePersonaIndex();
  return new Set(Object.values(index).map((e) => e.role));
}

/** Cached persona metadata index: name to role mapping for compile-time validation. */
export function getPersonaMetadataIndex(): PersonaMetadataIndex {
  return ensurePersonaIndex();
}
