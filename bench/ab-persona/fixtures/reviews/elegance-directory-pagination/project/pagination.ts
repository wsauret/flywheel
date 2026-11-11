import type { JsonClient } from "./json-client.ts";

interface Page {
  items: unknown[];
  nextCursor: string | null;
}

/** Fetch every page of a cursor-paginated list and parse each item. The
 *  directory service answers `{ "items": [...], "next_cursor": "..." }` and
 *  ends the list with a null cursor. */
export async function fetchAllPages<T>(client: JsonClient, path: string, parseItem: (value: unknown) => T): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let url = path;
  while (true) {
    const page = parsePage(await client.get(url), path);
    items.push(...page.items.map(parseItem));
    if (page.nextCursor === null) return items;
    // The cursor comes from another service; a repeated one would loop forever.
    if (seenCursors.has(page.nextCursor)) throw new Error(`${path}: the server repeated cursor ${page.nextCursor}`);
    seenCursors.add(page.nextCursor);
    url = `${path}?cursor=${encodeURIComponent(page.nextCursor)}`;
  }
}

function parsePage(body: unknown, path: string): Page {
  if (typeof body !== "object" || body === null) throw new Error(`${path}: page is not an object`);
  const fields: Record<string, unknown> = { ...body };
  const { items, next_cursor: nextCursor } = fields;
  if (!Array.isArray(items)) throw new Error(`${path}: page has no items array`);
  if (nextCursor !== null && typeof nextCursor !== "string") throw new Error(`${path}: next_cursor must be a string or null`);
  return { items, nextCursor };
}
