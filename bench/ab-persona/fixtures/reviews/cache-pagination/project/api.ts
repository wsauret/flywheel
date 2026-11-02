import { SwrCache } from "./cache.ts";
import { issueCursor, resolveCursor } from "./cursor.ts";
import type { Document, DocumentSource, ListRequest, Page, Query } from "./types.ts";

/** Cache key for one page of one viewer's listing. Keys are prefixed with the
 *  viewer id so permission changes can invalidate everything a viewer sees. */
function pageCacheKey(query: Query, offset: number, pageSize: number): string {
  return `${query.viewerId}:${query.sort}:${query.filter}:${offset}:${pageSize}`;
}

export class DocumentListApi {
  private revalidating = new Set<string>();

  constructor(
    private readonly source: DocumentSource,
    private readonly cache: SwrCache<readonly Document[]>,
  ) {}

  /** List documents for a viewer, one page at a time. First call omits the
   *  cursor; subsequent calls pass the `nextCursor` from the previous page. */
  async list(request: ListRequest): Promise<Page> {
    const state = request.cursor
      ? resolveCursor(request.cursor)
      : {
          query: {
            viewerId: request.viewerId,
            filter: request.filter ?? "",
            sort: request.sort,
            includeArchived: request.includeArchived,
          },
          offset: 0,
        };

    const items = await this.pageAt(state.query, state.offset, request.pageSize);
    const hasMore = items.length >= request.pageSize;
    let nextCursor: string | null = null;
    if (hasMore) {
      state.offset += items.length;
      nextCursor = issueCursor(state);
    }
    return { items, nextCursor, hasMore };
  }

  /** Serve a page from cache when possible; refresh stale pages in the
   *  background so hot listings never block on the source. */
  private async pageAt(query: Query, offset: number, pageSize: number): Promise<readonly Document[]> {
    const key = pageCacheKey(query, offset, pageSize);
    if (this.cache.isKnownEmpty(key)) {
      return [];
    }
    const cached = this.cache.get(key);
    if (cached.kind === "hit") {
      return cached.value;
    }
    if (cached.kind === "stale") {
      this.revalidate(query, offset, pageSize, key);
      return cached.value;
    }
    const rows = await this.source.fetch(query, offset, pageSize);
    this.store(key, rows);
    return rows;
  }

  private revalidate(query: Query, offset: number, pageSize: number, key: string): void {
    if (this.revalidating.has(key)) return;
    this.revalidating.add(key);
    void this.source
      .fetch(query, offset, pageSize)
      .then((rows) => this.store(key, rows))
      .finally(() => this.revalidating.delete(key));
  }

  private store(key: string, rows: readonly Document[]): void {
    if (rows.length === 0) {
      this.cache.markEmpty(key);
    } else {
      this.cache.set(key, rows);
    }
  }

  /** Called by the permissions service whenever a viewer's document access
   *  changes; every cached page for that viewer must be dropped. */
  onPermissionsChanged(viewerId: string): void {
    this.cache.invalidatePrefix(`${viewerId}:`);
  }
}
