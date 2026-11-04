import * as yaml from "js-yaml";
import { isRecord } from "./record.js";
import { loadYaml } from "./yaml-load.js";

interface FrontmatterFields { [key: string]: unknown }

export interface ParsedDoc {
  frontmatter: FrontmatterFields;
  body: string;
}

export function parseFrontmatter(content: string): ParsedDoc | null {
  if (!content.startsWith("---")) return null;

  const firstNewline = content.indexOf("\n", 3);
  if (firstNewline === -1) return null;

  const searchStart = firstNewline + 1;
  const closingMarker = "\n---";
  const closingIdx = content.indexOf(closingMarker, searchStart);
  if (closingIdx === -1) return null;

  const yamlStr = content.slice(firstNewline + 1, closingIdx);

  let bodyStart = closingIdx + closingMarker.length;
  if (bodyStart < content.length && content[bodyStart] === "\r") bodyStart++;
  if (bodyStart < content.length && content[bodyStart] === "\n") bodyStart++;

  const body = content.slice(bodyStart);
  const frontmatter = loadYamlRecord(yamlStr) ?? loadYamlRecord(quoteColonValues(yamlStr));
  return frontmatter ? { frontmatter, body } : null;
}

/** The js-yaml 4 default schema that frontmatter written before js-yaml 5
 *  relies on: `<<` merges and a sequence key joined into a string. A date
 *  stays its text, which no frontmatter reader takes as a date. */
const FRONTMATTER_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.legacyMapTag, yaml.mergeTag);

function loadYamlRecord(yamlStr: string): FrontmatterFields | null {
  try {
    const parsed: unknown = loadYaml(yamlStr, { schema: FRONTMATTER_SCHEMA }).document;
    return isRecord(parsed) ? parsed : null;
  } catch {
    // User-authored markdown is an external boundary: malformed YAML means
    // "no frontmatter", not an invariant violation.
    return null;
  }
}

/** Other agent clients read `description: Use when: X` as one string, and
 *  definitions written for them carry it; strict YAML refuses the second
 *  colon. The Agent Skills client guide
 *  (https://agentskills.io/client-implementation/adding-skills-support)
 *  recommends this quote-and-retry recovery. It runs only after strict
 *  parsing fails, and rewrites only top-level single-line plain values. An
 *  inline comment stays outside the quotes, so it never becomes value text. */
function quoteColonValues(yamlStr: string): string {
  return yamlStr.replace(
    /^([A-Za-z_][\w-]*):[ \t]+([^\s"'|>[{&*!#].*?)[ \t]*([ \t]#.*)?$/gm,
    (line, key: string, value: string, comment: string | undefined) =>
      value.includes(": ") ? `${key}: ${JSON.stringify(value)}${comment ?? ""}` : line,
  );
}
