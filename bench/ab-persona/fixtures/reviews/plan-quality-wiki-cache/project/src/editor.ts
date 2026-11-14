import type { Page } from "./pages";
import type { RenderDeps } from "./render";

export class EditError extends Error {}

/** Save an edited page. Throws EditError for an empty title or section. */
export function savePage(deps: RenderDeps, page: Page): void {
  if (page.title.trim() === "") throw new EditError("A page needs a title");
  if (page.section.trim() === "") throw new EditError("A page needs a section");
  deps.pages.save(page);
}
