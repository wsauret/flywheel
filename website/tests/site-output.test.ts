import { describe, expect, test } from "bun:test";

const outputPath = new URL("../dist/index.html", import.meta.url);
const outputFile = Bun.file(outputPath);

if (!(await outputFile.exists())) {
  throw new Error("website/dist/index.html is missing. Run the Astro build before this test.");
}

const html = await outputFile.text();

describe("built site output", () => {
  test("contains the required page structure and metadata", () => {
    expect(html.match(/<h1(?:\s|>)/g)?.length ?? 0).toBe(1);
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(html).toContain("<footer");
    expect(html).toContain("curl -fsSL https://github.com/wsauret/flywheel/releases/latest/download/install.sh | bash");
    expect(html).toContain("irm https://github.com/wsauret/flywheel/releases/latest/download/install.ps1 | iex");
    expect(html).toContain('<link rel="canonical" href="https://flywl.sh/">');
    expect(html).toMatch(/<meta property="og:title" content="[^"]+">/);
    expect(html).toContain("Apache 2.0");
    expect(html).not.toContain("MIT");
  });

  test("references only built font and media assets", async () => {
    const cssFiles = Array.fromAsync(new Bun.Glob("**/*.css").scan({ cwd: new URL("../dist", import.meta.url).pathname }));
    const css = (await Promise.all((await cssFiles).map((path) => Bun.file(new URL(`../dist/${path}`, import.meta.url)).text()))).join("\n");
    const paths = new Set([...`${html}\n${css}`.matchAll(/["'(](\/(?:fonts|media)\/[^"')\s]+)/g)].map((match) => match[1]));

    for (const path of paths) {
      expect(path, `${path} must exist in website/dist`).toBeDefined();
      expect(await Bun.file(new URL(`../dist${path}`, import.meta.url)).exists()).toBe(true);
    }
  });

  test("does not contain banned marketing claims", () => {
    for (const phrase of ["benchmark", "state of the art", "state-of-the-art", "blazing", "revolutionary", "10x faster"]) {
      expect(html.toLowerCase()).not.toContain(phrase);
    }
  });

  test("renders both install commands visible before JavaScript runs", () => {
    expect(html).not.toMatch(/<div[^>]*role="tabpanel"[^>]*hidden/);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("404 page keeps a main landmark", async () => {
    const notFound = await Bun.file(new URL("../dist/404.html", import.meta.url)).text();
    expect(notFound).toContain("<main");
    expect(notFound.match(/<h1(?:\s|>)/g)?.length ?? 0).toBe(1);
  });
});
