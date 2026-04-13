/**
 * Shared YAML frontmatter parser.
 *
 * Uses index-based splitting on the second `---` delimiter so that
 * performance is O(frontmatter size), not O(file size).
 */

import * as yaml from "js-yaml";

// Types

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ParseFrontmatterOptions {
  /** YAML schema to use (e.g. yaml.JSON_SCHEMA). Defaults to yaml.DEFAULT_SCHEMA. */
  schema?: yaml.Schema;
}

// Public API

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
  // Must start with "---" followed by a newline (LF or CRLF)
  if (!content.startsWith("---")) return null;

  // Find the newline after the opening "---"
  const firstNewline = content.indexOf("\n", 3);
  if (firstNewline === -1) return null;

  // Find the closing "---" delimiter.
  // Search for "\n---\n" or "\n---\r\n" or "\n---" at EOF.
  const searchStart = firstNewline + 1;
  const closingMarker = "\n---";
  const closingIdx = content.indexOf(closingMarker, searchStart);
  if (closingIdx === -1) return null;

  // Extract the raw YAML between the delimiters
  const yamlStr = content.slice(firstNewline + 1, closingIdx);

  // Determine where the body starts (after "---" + optional newline)
  let bodyStart = closingIdx + closingMarker.length;
  if (bodyStart < content.length && content[bodyStart] === "\r") bodyStart++;
  if (bodyStart < content.length && content[bodyStart] === "\n") bodyStart++;

  const body = content.slice(bodyStart);

  // Parse the YAML
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
