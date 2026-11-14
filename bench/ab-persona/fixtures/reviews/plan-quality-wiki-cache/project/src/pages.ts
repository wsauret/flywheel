export interface Page {
  readonly slug: string;
  readonly section: string;
  readonly title: string;
  readonly body: string;
}

export class PageStore {
  readonly #pages = new Map<string, Page>();

  get(slug: string): Page | undefined {
    return this.#pages.get(slug);
  }

  inSection(section: string): readonly Page[] {
    return [...this.#pages.values()].filter((page) => page.section === section).sort((a, b) => a.title.localeCompare(b.title));
  }

  save(page: Page): void {
    this.#pages.set(page.slug, page);
  }
}
