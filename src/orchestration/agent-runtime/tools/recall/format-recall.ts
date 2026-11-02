import type { RecallHit } from "../../../../protocol/conversation-recall.js";

export const formatRecallOutput = (
  entries: readonly RecallHit[],
  query?: string,
  headerOverride?: string,
): string => {
  if (entries.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }
  const header = headerOverride
    ? `${headerOverride} for "${query}":`
    : query
      ? `Found ${entries.length} matches for "${query}":`
      : `Session history (${entries.length} entries):`;
  const lines = entries.map((e) => {
    const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
    if (e.text !== undefined && e.totalLength !== undefined && e.offset !== undefined) {
      const end = e.offset + e.text.length;
      const continuation = e.nextOffset === undefined ? "" : ` nextOffset:${e.nextOffset}`;
      return `#${e.index} id:${e.entryId} [${e.role}]${fileSuffix} offset:${e.offset}-${end}/${e.totalLength}${continuation}\n${e.text}`;
    }
    const body = query && e.snippet ? e.snippet : (e.summary ?? "");
    return `#${e.index} id:${e.entryId} [${e.role}]${fileSuffix} ${body}`;
  });
  return `${header}\n\n${lines.join("\n\n")}`;
};
