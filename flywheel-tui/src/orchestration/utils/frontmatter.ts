/**
 * Shared YAML frontmatter parser.
 *
 * Uses index-based splitting on the second `---` delimiter so that
 * performance is O(frontmatter size), not O(file size).
 */

import * as yaml from "js-yaml";

interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ParseFrontmatterOptions {
  /** YAML schema to use (e.g. yaml.JSON_SCHEMA). Defaults to yaml.DEFAULT_SCHEMA. */
  schema?: yaml.Schema;
}

/**
 * Parse YAML frontmatter delimited by `---` at the start of a string.
 *
 * Returns `{ frontmatter, body }` on success, or `null` if:
 * - No frontmatter delimiters found
 * - YAML is malformed
 * - YAML parses to a non-object value
 *
 * @param content  - The full file content
 * @param options  - Optional YAML parsing options (e.g. schema)
 */
export function parseFrontmatter(
  content: string,
  options?: ParseFrontmatterOptions,
): ParsedDoc | null {
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

  try {
    const loadOptions: yaml.LoadOptions = {};
    if (options?.schema) {
      loadOptions.schema = options.schema;
    }

    const parsed = yaml.load(yamlStr, loadOptions);

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      return null;
    }

    return { frontmatter: parsed as Record<string, unknown>, body };
  } catch {
    return null;
  }
}
