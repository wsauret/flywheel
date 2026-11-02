/**
 * Exa-backed web search provider (https://docs.exa.ai).
 *
 * Search and page reading both run server-side on api.exa.ai: `search_query`
 * maps to POST /search (with page text included) and `open` maps to POST
 * /contents, so this process never fetches an arbitrary web page itself.
 * Exa keeps no retrieval state between calls, so the shared retrieval store
 * supplies the cross-call protocol: minted ref ids, cached documents for
 * `find`, and extracted link lists for `click`.
 *
 * External boundary in both directions: responses are normalized
 * permissively and every failure surfaces as a WebSearchError. The API key
 * accessor is read at call time (auth store override first, then env, via
 * AuthContext) and the key goes only into the request header.
 */

import { Redacted } from "effect";
import { isRecord } from "../../../infra/record.js";
import { postJson } from "./http.js";
import { createRetrievalStore, MAX_DOCUMENT_CHARS, type RetrievalDocument, type RetrievalSession } from "./retrieval-session.js";
import { WebSearchError, type ResponseLength, type WebSearchCommand, type WebSearchProvider, type WebSearchQuery, type WebSearchResponse, type WebSearchResult } from "./types.js";

const SEARCH_ENDPOINT = "https://api.exa.ai/search";
const CONTENTS_ENDPOINT = "https://api.exa.ai/contents";

const RESULTS_PER_QUERY = 8;
const SNIPPET_CHARS = 400;
const HIGHLIGHT_SENTENCES = 3;
const HIGHLIGHTS_PER_URL = 2;
const MAX_LINKS = 40;
const MAX_FIND_MATCHES = 40;
interface ResponseLengthWindows {
  short: number;
  medium: number;
  long: number;
}

interface ExternalObject {
  [field: string]: unknown;
}
/** Lines of an opened document returned per call, centered on `lineno`.
 *  `response_length` selects the window; medium matches the previous fixed
 *  window. */
const WINDOW_LINES: ResponseLengthWindows = { short: 120, medium: 400, long: 1200 };

export interface ExaWebSearchOverrides {
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Transient-retry pause; tests shrink it so retries stay fast. */
  retryDelayMs?: number;
}

/** `apiKey` is read at call time so a key stored through /auth mid-session
 *  takes effect on the next request without a restart. */
export function createExaWebSearch(apiKey: () => Redacted.Redacted<string> | undefined, overrides?: ExaWebSearchOverrides): WebSearchProvider {
  const store = createRetrievalStore();

  async function post(endpoint: string, payload: ExternalObject, signal: AbortSignal | undefined): Promise<ExternalObject> {
    const key = apiKey();
    if (!key) throw new WebSearchError("no Exa API key is configured for the active auth profile; add one in /auth");
    const response = await postJson(endpoint, {
      headers: { "x-api-key": Redacted.value(key), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
      ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides?.retryDelayMs !== undefined ? { retryDelayMs: overrides.retryDelayMs } : {}),
    });
    if (response.status === 401 || response.status === 403) {
      throw new WebSearchError("the Exa API key was rejected by api.exa.ai; check the key");
    }
    if (response.status === 429) {
      throw new WebSearchError("Exa rate-limited this key; wait before searching again");
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new WebSearchError(`Exa returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) throw new WebSearchError("Exa returned an unreadable response body");
    return body;
  }

  async function search(session: RetrievalSession, query: WebSearchQuery, signal: AbortSignal | undefined): Promise<WebSearchResult[]> {
    const body = await post(SEARCH_ENDPOINT, {
      query: query.q,
      numResults: RESULTS_PER_QUERY,
      ...(query.domains && query.domains.length > 0 ? { includeDomains: query.domains } : {}),
      ...(query.recency !== undefined ? { startPublishedDate: new Date(Date.now() - query.recency * 86_400_000).toISOString() } : {}),
      // Query-aware extracted passages, not page-text prefixes: highlights
      // give answer-bearing snippets the way the ChatGPT harness digest does.
      contents: { highlights: { numSentences: HIGHLIGHT_SENTENCES, highlightsPerUrl: HIGHLIGHTS_PER_URL, query: query.q } },
    }, signal);
    // A 2xx body without a results collection is contract drift, not an
    // empty search; an invented "no results" would be false evidence.
    if (!Array.isArray(body.results)) {
      throw new WebSearchError("Exa returned a response without a results collection");
    }
    const results: WebSearchResult[] = [];
    for (const item of body.results) {
      if (!isRecord(item) || typeof item.url !== "string") continue;
      const snippet = Array.isArray(item.highlights)
        ? item.highlights.filter(<Value>(highlight: Value): highlight is Value & string => typeof highlight === "string").join(" ... ").slice(0, SNIPPET_CHARS) || undefined
        : undefined;
      results.push({
        refId: session.mintResultRef(item.url),
        url: item.url,
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
      });
    }
    return results;
  }

  /** The session's cached copy of the page a ref names, fetching through
   *  /contents only when the URL was not opened in this session yet. */
  async function ensureDocument(session: RetrievalSession, refId: string, signal: AbortSignal | undefined): Promise<{ document: RetrievalDocument; viewRef: string }> {
    const url = session.resolveUrl(refId);
    if (!url) throw new WebSearchError(`unknown ref_id "${refId}": use a ref_id from earlier results in this session, or a full URL`);
    const cached = session.document(url);
    if (cached) return { document: cached, viewRef: refId };
    const body = await post(CONTENTS_ENDPOINT, {
      urls: [url],
      text: true,
      extras: { links: MAX_LINKS },
    }, signal);
    const entry = Array.isArray(body.results) ? body.results.find(isRecord) : undefined;
    const text = entry && typeof entry.text === "string" ? entry.text : undefined;
    if (text === undefined) throw new WebSearchError(`Exa returned no content for ${url}`);
    const links = entry && isRecord(entry.extras) && Array.isArray(entry.extras.links)
      ? entry.extras.links.filter(<Value>(link: Value): link is Value & string => typeof link === "string").slice(0, MAX_LINKS)
      : [];
    const document: RetrievalDocument = {
      url,
      ...(entry && typeof entry.title === "string" ? { title: entry.title } : {}),
      lines: text.slice(0, MAX_DOCUMENT_CHARS).split("\n"),
      links,
    };
    return { document, viewRef: session.saveDocument(document) };
  }

  async function open(session: RetrievalSession, refId: string, lineno: number | undefined, length: ResponseLength, signal: AbortSignal | undefined): Promise<string> {
    const { document, viewRef } = await ensureDocument(session, refId, signal);
    return renderDocument(document, viewRef, lineno ?? 0, length);
  }

  async function find(session: RetrievalSession, refId: string, pattern: string, signal: AbortSignal | undefined): Promise<string> {
    // A find against a not-yet-opened ref fetches the page first, mirroring
    // the server-side harness where find implies the document.
    const { document } = await ensureDocument(session, refId, signal);
    const needle = pattern.toLowerCase();
    const matches: string[] = [];
    for (const [index, line] of document.lines.entries()) {
      if (matches.length >= MAX_FIND_MATCHES) break;
      if (line.toLowerCase().includes(needle)) matches.push(`L${index}: ${line.trim()}`);
    }
    const heading = `find "${pattern}" in ${document.title ?? document.url} (${document.url})`;
    return matches.length > 0 ? `${heading}\n${matches.join("\n")}` : `${heading}\nNo matches.`;
  }

  async function click(session: RetrievalSession, refId: string, linkId: number, length: ResponseLength, signal: AbortSignal | undefined): Promise<string> {
    const document = session.document(refId);
    if (!document) throw new WebSearchError(`unknown ref_id "${refId}": click needs a page opened earlier in this session`);
    const target = document.links[linkId];
    if (target === undefined) throw new WebSearchError(`page ${refId} has no link ${linkId}; open it to see the numbered link list`);
    return open(session, target, undefined, length, signal);
  }

  return {
    id: "exa",
    available: () => Boolean(apiKey()),

    async run(command: WebSearchCommand, options): Promise<WebSearchResponse> {
      const session = store.session(options.retrievalSessionId);
      const length = command.response_length ?? "medium";
      const results: WebSearchResult[] = [];
      const sections: string[] = [];
      for (const query of command.search_query ?? []) {
        results.push(...await search(session, query, options.signal));
      }
      for (const operation of command.open ?? []) {
        sections.push(await open(session, operation.ref_id, operation.lineno, length, options.signal));
      }
      for (const operation of command.click ?? []) {
        sections.push(await click(session, operation.ref_id, operation.id, length, options.signal));
      }
      for (const operation of command.find ?? []) {
        sections.push(await find(session, operation.ref_id, operation.pattern, options.signal));
      }
      return {
        results,
        ...(sections.length > 0 ? { output: sections.join("\n\n") } : {}),
      };
    },
  };
}

function renderDocument(document: RetrievalDocument, viewRef: string, lineno: number, length: ResponseLength): string {
  const windowLines = WINDOW_LINES[length];
  const total = document.lines.length;
  const start = Math.max(0, Math.min(Math.floor(lineno), Math.max(0, total - 1)));
  const end = Math.min(total, start + windowLines);
  const header = `${document.title ?? document.url} (${document.url}) [${viewRef}]\nTotal lines: ${total}${end < total ? `; showing L${start}-L${end - 1}; reopen with lineno to see more` : ""}`;
  const body = document.lines.slice(start, end).map((line, index) => `L${start + index}: ${line}`).join("\n");
  const links = document.links.length > 0
    ? `\nLinks (click by id with ref_id ${viewRef}):\n${document.links.map((link, index) => `[${index}] ${link}`).join("\n")}`
    : "";
  return `${header}\n${body}${links}`;
}
