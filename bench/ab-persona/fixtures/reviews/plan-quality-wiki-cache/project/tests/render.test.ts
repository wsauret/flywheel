import { describe, expect, test } from "bun:test";
import { TtlCache } from "../src/cache";
import { PageStore } from "../src/pages";
import { renderPage, renderSectionIndex } from "../src/render";

function deps() {
  const pages = new PageStore();
  pages.save({ slug: "launching", section: "boats", title: "Launching a boat", body: "Check the bung." });
  pages.save({ slug: "oars", section: "boats", title: "Oars", body: "Blades up." });
  return { pages, cache: new TtlCache(600_000) };
}

describe("render", () => {
  test("a page renders in both views and is cached per view", () => {
    const d = deps();
    expect(renderPage(d, "launching", "html")).toContain("<h1>Launching a boat</h1>");
    expect(renderPage(d, "launching", "print")).toContain('class="print"');
    expect(d.cache.size).toBe(2);
  });

  test("the section index lists the section's pages by title", () => {
    expect(renderSectionIndex(deps(), "boats")).toBe(
      '<ul class="section"><li><a href="/launching">Launching a boat</a></li><li><a href="/oars">Oars</a></li></ul>',
    );
  });
});
