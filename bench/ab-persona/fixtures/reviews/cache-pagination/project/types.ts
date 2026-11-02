export interface Document {
  id: string;
  title: string;
  ownerId: string;
  archived: boolean;
  updatedAt: number;
}

export interface ListRequest {
  viewerId: string;
  filter?: string;
  sort: "updated" | "title";
  pageSize: number;
  /** Opaque token from a previous page's `nextCursor`. */
  cursor?: string;
  /** Admin-only: include archived documents in results. */
  includeArchived: boolean;
}

export interface Page {
  items: readonly Document[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface DocumentSource {
  /** Documents visible to `viewerId`, filtered/sorted, `limit` rows starting
   *  at `offset`. Enforces per-viewer permissions. */
  fetch(query: Query, offset: number, limit: number): Promise<readonly Document[]>;
}

export interface Query {
  viewerId: string;
  filter: string;
  sort: "updated" | "title";
  includeArchived: boolean;
}

export interface CacheClock {
  now(): number;
}
