/**
 * Shared vocabulary of the web retrieval surface: the command the `web` tool
 * authors, the normalized response every provider returns, and the provider
 * contract the selector composes. Providers differ in where retrieval state
 * lives (ChatGPT keeps it server-side; Exa uses the client-side retrieval
 * store), but they present one command language so the tool advertises one
 * schema regardless of backend.
 */

export type WebSearchProviderId = "chatgpt" | "exa";

export type ResponseLength = "short" | "medium" | "long";

export interface WebSearchQuery {
  q: string;
  /** Restrict results to pages published within this many days. */
  recency?: number;
  /** Restrict results to these domains. */
  domains?: readonly string[];
}

/** One retrieval command. `ref_id`s (e.g. "turn0search0") resolve against
 *  earlier commands of the same session; `open.ref_id` also accepts a fully
 *  qualified URL. */
export interface WebSearchCommand {
  search_query?: readonly WebSearchQuery[];
  open?: ReadonlyArray<{ ref_id: string; lineno?: number }>;
  click?: ReadonlyArray<{ ref_id: string; id: number }>;
  find?: ReadonlyArray<{ ref_id: string; pattern: string }>;
  response_length?: ResponseLength;
}

export interface WebSearchResult {
  refId?: string;
  title?: string;
  url?: string;
  snippet?: string;
}

export interface WebSearchResponse {
  /** Rendered document content for open/click/find operations. */
  output?: string;
  results: readonly WebSearchResult[];
}

export interface WebSearchRunOptions {
  /** Stable retrieval identity: the scope `ref_id`s resolve in, whichever
   *  side of the wire holds that state. */
  retrievalSessionId: string;
  signal?: AbortSignal;
}

/** The retrieval surface the exposure planner and the `web` tool consume.
 *  `available()` is read per plan, so credentials that land mid-session take
 *  effect on the next request without a restart. */
export interface WebSearchPort {
  available(): boolean;
  run(command: WebSearchCommand, options: WebSearchRunOptions): Promise<WebSearchResponse>;
}

/** One provider behind the capability: the selector picks among these. */
export interface WebSearchProvider extends WebSearchPort {
  readonly id: WebSearchProviderId;
}

export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}
