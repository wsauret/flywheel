import type { TtlCache } from "./cache";
import type { PageStore } from "./pages";

export type View = "html" | "print";

export interface RenderDeps {
  readonly pages: PageStore;
  readonly cache: TtlCache;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Stands in for the Markdown renderer: one paragraph per blank-line-separated block. */
function markdownToHtml(body: string): string {
  return body.split(/\n{2,}/).map((block) => `<p>${escapeHtml(block.trim())}</p>`).join("\n");
}

/** The rendered page, cached under `page:<slug>:<view>`. */
export function renderPage(deps: RenderDeps, slug: string, view: View): string | undefined {
  const key = `page:${slug}:${view}`;
  const cached = deps.cache.get(key);
  if (cached !== undefined) return cached;
  const page = deps.pages.get(slug);
  if (page === undefined) return undefined;
  const html = view === "print"
    ? `<article class="print"><h1>${escapeHtml(page.title)}</h1>\n${markdownToHtml(page.body)}</article>`
    : `<article><h1>${escapeHtml(page.title)}</h1>\n${markdownToHtml(page.body)}</article>`;
  deps.cache.set(key, html);
  return html;
}

/** The sidebar list of a section's pages, cached under `section:<section>`. */
export function renderSectionIndex(deps: RenderDeps, section: string): string {
  const key = `section:${section}`;
  const cached = deps.cache.get(key);
  if (cached !== undefined) return cached;
  const items = deps.pages.inSection(section).map((page) => `<li><a href="/${page.slug}">${escapeHtml(page.title)}</a></li>`);
  const html = `<ul class="section">${items.join("")}</ul>`;
  deps.cache.set(key, html);
  return html;
}
