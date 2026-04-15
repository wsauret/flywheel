import * as yaml from "js-yaml";

interface ParsedDoc {
  frontmatter: Record<string, unknown>;
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

  try {
    const parsed = yaml.load(yamlStr);

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      return null;
    }

    return { frontmatter: parsed as Record<string, unknown>, body };
  } catch {
    return null;
  }
}
