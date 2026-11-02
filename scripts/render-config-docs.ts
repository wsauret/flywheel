import { configReference, type ConfigReference, type ConfigReferenceEntry } from "../src/orchestration/config/config-reference.js";
import { settingDefinitions, type ApplicationMode } from "../src/orchestration/config/setting-definitions.js";

const APPLICATION_NOTES = {
  live: "Applies to the running interface immediately.",
  "next-request": "Applies when the next provider request captures configuration.",
  "replace-resource": "Applies after the replacement resource is ready.",
  "use-time-revalidate": "Revalidates from disk when the protected operation starts.",
  "next-use": "Applies the next time Flywheel reads this setting.",
} satisfies { readonly [Mode in ApplicationMode]: string };

/** Locale-independent order, so a render reads the same on every machine. */
export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type DocumentationValue = string | number | boolean | null | readonly DocumentationValue[] | DocumentationDictionary;
interface DocumentationDictionary { [key: string]: DocumentationValue }

function stableValue(value: unknown): DocumentationValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => compareCodePoints(left, right)).map(([key, child]) => [key, stableValue(child)]));
  throw new Error(`Unsupported configuration documentation value: ${String(value)}`);
}

function encoded(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

type ConstraintNode = { [key: string]: unknown };

function isConstraintNode(value: unknown): value is ConstraintNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Effect encodes JSON numbers as anyOf [number, "NaN", "Infinity", "-Infinity"].
// The sentinels are wire-format noise, not authorable values; read the union as
// a plain number.
function isNumberEncoding(node: ConstraintNode): boolean {
  const variants = node.anyOf;
  if (!Array.isArray(variants) || variants.length !== 4) return false;
  const [head, ...sentinels] = variants;
  return isConstraintNode(head) && head.type === "number"
    && sentinels.every((variant) => isConstraintNode(variant) && variant.type === "string" && Array.isArray(variant.enum));
}

interface ConstraintFacts {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
}

function constraintFacts(node: ConstraintNode): ConstraintFacts {
  const clauses = [node, ...(Array.isArray(node.allOf) ? node.allOf.filter(isConstraintNode) : [])];
  const fact = (key: keyof ConstraintFacts): number | undefined => {
    for (const clause of clauses) if (typeof clause[key] === "number") return clause[key];
    return undefined;
  };
  return { minimum: fact("minimum"), maximum: fact("maximum"), minLength: fact("minLength") };
}

function boundsText(facts: ConstraintFacts): string | undefined {
  if (facts.minimum !== undefined && facts.maximum !== undefined) return `${facts.minimum} to ${facts.maximum}`;
  if (facts.minimum !== undefined) return `at least ${facts.minimum}`;
  if (facts.maximum !== undefined) return `at most ${facts.maximum}`;
  return undefined;
}

function numericSummary(base: "integer" | "number", facts: ConstraintFacts): string {
  const bounds = boundsText(facts);
  return bounds === undefined ? base : `${base}, ${bounds}`;
}

const PLURALS = new Map([
  ["string", "strings"],
  ["non-empty string", "non-empty strings"],
  ["integer", "integers"],
  ["number", "numbers"],
  ["boolean", "booleans"],
]);

/** Human phrase for one constraint dictionary, or undefined when the Type line
 *  already says everything (plain boolean, plain string). Branches of a union
 *  always get a phrase so "X or Y" reads whole. */
export function constraintSummary(constraints: unknown): string | undefined {
  if (!isConstraintNode(constraints)) return undefined;
  const node = constraints;
  const facts = constraintFacts(node);
  if (isNumberEncoding(node)) return boundsText(facts) === undefined ? undefined : numericSummary("number", facts);
  if (Array.isArray(node.enum)) return node.enum.map((value) => encoded(value)).join(" or ");
  if (Array.isArray(node.anyOf)) return node.anyOf.map((variant) => summaryOrType(variant)).join(" or ");
  if (node.type === "integer") return numericSummary("integer", facts);
  if (node.type === "number") return boundsText(facts) === undefined ? undefined : numericSummary("number", facts);
  if (node.type === "string") return facts.minLength !== undefined && facts.minLength >= 1 ? "non-empty string" : undefined;
  if (node.type === "array") {
    const item = summaryOrType(node.items);
    return `list of ${PLURALS.get(item) ?? `${item} values`}`;
  }
  if (node.type === "object" && isConstraintNode(node.properties)) return `table with keys: ${Object.keys(node.properties).toSorted(compareCodePoints).join(", ")}`;
  return undefined;
}

function summaryOrType(constraints: unknown): string {
  const summary = constraintSummary(constraints);
  if (summary !== undefined) return summary;
  if (isConstraintNode(constraints)) {
    if (isNumberEncoding(constraints)) return "number";
    if (typeof constraints.type === "string") return constraints.type;
  }
  return "value";
}

function assertEntryMetadata(entry: ConfigReferenceEntry): void {
  if (entry.path.length === 0) throw new Error("Missing authored TOML path");
  if (entry.type.length === 0) throw new Error(`Missing type for ${entry.path}`);
  if (entry.description.length === 0) throw new Error(`Missing description for ${entry.path}`);
  if (entry.constraints === undefined && entry.openVocabulary === undefined) throw new Error(`Missing constraints or open vocabulary for ${entry.path}`);
  if (entry.defaultState.kind === "decoded" && !("value" in entry.defaultState)) throw new Error(`Missing decoded default for ${entry.path}`);
  if (entry.snippet.length === 0) throw new Error(`Missing snippet for ${entry.path}`);
}

function applicationModes(entry: ConfigReferenceEntry): readonly ApplicationMode[] {
  const definition = settingDefinitions().find((candidate) => {
    const path = candidate.kind === "retained-section" ? [candidate.key] : candidate.path;
    return path.every((segment, index) => entry.authoredSegments[index] === segment);
  });
  if (definition === undefined) throw new Error(`Missing applications for ${entry.path}`);
  const definitionPath = definition.kind === "retained-section" ? [definition.key] : definition.path;
  const relativePath = entry.authoredSegments.slice(definitionPath.length);
  const applications = definition.applications.filter(({ path }) =>
    path.every((segment, index) => relativePath[index] === segment));
  if (applications.length === 0) throw new Error(`Missing applications for ${entry.path}`);
  return [...new Set(applications.map(({ mode }) => mode))];
}

function metadataLines(entry: ConfigReferenceEntry): string[] {
  const modes = applicationModes(entry);
  const lines = [
    `- Type: \`${entry.type}\``,
    entry.openVocabulary === undefined
      ? Array.isArray(entry.constraints?.enum)
        ? `- Allowed values: ${entry.constraints.enum.map((value) => `\`${encoded(value)}\``).join(", ")}`
        : constraintLine(entry.constraints)
      : `- Shape: ${entry.openVocabulary}`,
    entry.defaultState.kind === "unset" ? "- Default: unset" : `- Default: \`${encoded(entry.defaultState.value)}\``,
    ...modes.map((mode) => `- Application: \`${mode}\`. ${APPLICATION_NOTES[mode]}`),
  ].filter((line): line is string => line !== undefined);
  if (entry.branch !== undefined) lines.push(`- Branch: ${entry.branch}`);
  return lines;
}

function constraintLine(constraints: unknown): string | undefined {
  const summary = constraintSummary(constraints);
  return summary === undefined ? undefined : `- Constraints: ${summary}`;
}

function renderEntry(entry: ConfigReferenceEntry): string {
  assertEntryMetadata(entry);
  const example = entry.ownership === "runtime-owned" ? entry.snippet : entry.example;
  if (example === undefined) throw new Error(`Missing authored TOML example for ${entry.path}`);
  return [`### \`${entry.path}\``, "", ...metadataLines(entry), "", entry.description, "", "```toml", example, "```"].join("\n");
}

export function renderConfigurationDocs(reference: ConfigReference = configReference()): string {
  const entries = [...reference.entries].toSorted((left, right) => compareCodePoints(`${left.path}\u0000${left.branch ?? ""}`, `${right.path}\u0000${right.branch ?? ""}`));
  const sections = new Map<string, ConfigReferenceEntry[]>();
  for (const entry of entries) {
    assertEntryMetadata(entry);
    const root = entry.path.split(".")[0] ?? entry.path;
    const section = sections.get(root) ?? [];
    section.push(entry);
    sections.set(root, section);
  }
  const body = [...sections.entries()].toSorted(([left], [right]) => compareCodePoints(left, right)).map(([root, sectionEntries]) => [`## \`${root}\``, "", sectionEntries.map(renderEntry).join("\n\n")].join("\n")).join("\n\n");
  return ["# Flywheel configuration reference", "", "This file is generated from the configuration schema. Run `bun run docs:generate` to update it.", "", body].join("\n").trimEnd() + "\n";
}
