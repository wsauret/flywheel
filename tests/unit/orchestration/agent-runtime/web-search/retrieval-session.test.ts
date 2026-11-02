import { describe, expect, it } from "bun:test";
import { createRetrievalStore } from "../../../../../src/orchestration/agent-runtime/web-search/retrieval-session.js";
import type { RetrievalDocument } from "../../../../../src/orchestration/agent-runtime/web-search/retrieval-session.js";

function doc(url: string): RetrievalDocument {
  return { url, lines: ["one line"], links: [] };
}

describe("retrieval store", () => {
  it("resolves search refs, view refs, and raw URLs to one cached document", () => {
    const session = createRetrievalStore().session("s");
    const searchRef = session.mintResultRef("https://a/");
    const viewRef = session.saveDocument(doc("https://a/"));
    expect(session.document(searchRef)).toBe(session.document(viewRef));
    expect(session.document("https://a/")).toBe(session.document(searchRef));
  });

  it("keeps one canonical document per URL when reopened", () => {
    const session = createRetrievalStore().session("s");
    session.saveDocument(doc("https://a/"));
    const updated: RetrievalDocument = { url: "https://a/", lines: ["new content"], links: [] };
    const secondRef = session.saveDocument(updated);
    expect(session.document(secondRef)?.lines).toEqual(["new content"]);
    expect(session.document("https://a/")?.lines).toEqual(["new content"]);
  });

  it("access refreshes document recency, protecting it from eviction", () => {
    const session = createRetrievalStore().session("s");
    for (let index = 0; index < 50; index += 1) {
      session.saveDocument(doc(`https://page-${index}/`));
    }
    session.document("https://page-0/");
    session.saveDocument(doc("https://one-more/"));
    expect(session.document("https://page-0/")).toBeDefined();
    expect(session.document("https://page-1/")).toBeUndefined();
  });

  it("evicts the oldest ref past the per-session ref bound", () => {
    const session = createRetrievalStore().session("s");
    const first = session.mintResultRef("https://first/");
    for (let index = 0; index < 500; index += 1) {
      session.mintResultRef(`https://later-${index}/`);
    }
    expect(session.resolveUrl(first)).toBeUndefined();
  });

  it("evicts the least recently used session past the store bound", () => {
    const store = createRetrievalStore();
    const ref = store.session("first").mintResultRef("https://a/");
    for (let index = 0; index < 64; index += 1) {
      store.session(`filler-${index}`);
    }
    expect(store.session("first").resolveUrl(ref)).toBeUndefined();
  });

});
