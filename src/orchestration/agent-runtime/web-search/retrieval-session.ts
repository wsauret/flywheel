/**
 * Client-side retrieval state for web search providers whose backend keeps
 * none (Exa today; any future search API). It gives such providers the same
 * cross-call protocol the ChatGPT harness gets server-side: search results
 * and opened pages receive ref ids, `open`/`find`/`click` resolve those refs
 * later in the session, and link lists make `click` addressable by number.
 *
 * Everything here is derived from provider responses and dies with the
 * process; nothing projects from it. All collections are bounded so a long
 * session cannot grow memory without limit.
 */

const MAX_SESSIONS = 64;
const MAX_DOCUMENTS_PER_SESSION = 50;
const MAX_REFS_PER_SESSION = 500;
export const MAX_DOCUMENT_CHARS = 200_000;

export interface RetrievalDocument {
  url: string;
  title?: string;
  lines: readonly string[];
  /** Absolute URLs extracted from the page, addressable by `click` index. */
  links: readonly string[];
}

export interface RetrievalSession {
  /** Mint a ref id for one search result. */
  mintResultRef(url: string): string;
  /** Cache one opened document (canonically by URL) and mint a view ref. */
  saveDocument(document: RetrievalDocument): string;
  /** The URL a ref names, or the ref itself when it is already a URL. */
  resolveUrl(refId: string): string | undefined;
  /** The cached document a ref names. Any ref that resolves to an opened
   *  URL (search ref, view ref, or the raw URL) reaches the one cached
   *  copy; access refreshes its LRU recency. */
  document(refId: string): RetrievalDocument | undefined;
}

interface RetrievalStore {
  session(sessionId: string): RetrievalSession;
}

interface SessionState {
  counter: number;
  /** ref id -> URL. */
  refs: Map<string, string>;
  /** Canonical URL -> the one cached document for that page. */
  documents: Map<string, RetrievalDocument>;
}

/** One store per provider instance; sessions are evicted least-recently-used. */
export function createRetrievalStore(): RetrievalStore {
  const sessions = new Map<string, SessionState>();

  function sessionState(sessionId: string): SessionState {
    const existing = sessions.get(sessionId);
    if (existing) {
      // Re-insert for LRU recency.
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    const created: SessionState = { counter: 0, refs: new Map(), documents: new Map() };
    sessions.set(sessionId, created);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    return created;
  }

  return {
    session(sessionId) {
      const state = sessionState(sessionId);
      const remember = (refId: string, url: string): void => {
        state.refs.set(refId, url);
        if (state.refs.size > MAX_REFS_PER_SESSION) {
          const oldest = state.refs.keys().next().value;
          if (oldest !== undefined) state.refs.delete(oldest);
        }
      };
      return {
        mintResultRef(url) {
          state.counter += 1;
          const refId = `search${state.counter}`;
          remember(refId, url);
          return refId;
        },
        saveDocument(document) {
          state.counter += 1;
          const refId = `view${state.counter}`;
          remember(refId, document.url);
          // One canonical document per URL: re-opening replaces the copy, so
          // every ref that resolves to this URL reads the same content.
          state.documents.delete(document.url);
          state.documents.set(document.url, document);
          if (state.documents.size > MAX_DOCUMENTS_PER_SESSION) {
            const oldest = state.documents.keys().next().value;
            if (oldest !== undefined) state.documents.delete(oldest);
          }
          return refId;
        },
        resolveUrl(refId) {
          const known = state.refs.get(refId);
          if (known) return known;
          return /^https?:\/\//.test(refId) ? refId : undefined;
        },
        document(refId) {
          const url = state.refs.get(refId) ?? refId;
          const cached = state.documents.get(url);
          if (cached) {
            // Re-insert for LRU recency.
            state.documents.delete(url);
            state.documents.set(url, cached);
          }
          return cached;
        },
      };
    },
  };
}
