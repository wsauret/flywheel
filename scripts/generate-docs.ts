import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Log } from "../src/infra/log.js";
import { renderConfigurationDocs } from "./render-config-docs.js";
import { renderCliReference, renderCommandReference, renderKeyReference } from "./render-reference-docs.js";

// The generated user reference pages. The installer publishes each of them
// to the user data root (USER_GUIDE_SOURCES), and `bun run lint` fails while
// any page differs from its render, so a release never ships a stale page.
//
// Usage: bun run docs:generate      writes every page
//        bun run lint:generated-docs  checks every page and writes nothing

const DOCS_DIRECTORY = join(import.meta.dir, "../src/workflows/docs");

const GENERATED_DOCS: readonly { readonly file: string; readonly render: () => string | Promise<string> }[] = [
  { file: "configuration.md", render: () => renderConfigurationDocs() },
  { file: "cli.md", render: () => renderCliReference() },
  { file: "commands.md", render: () => renderCommandReference() },
  { file: "keys.md", render: () => renderKeyReference() },
];

export type GeneratedDocStatus = { readonly file: string; readonly status: "current" | "missing" | "different" };

/** Compares every generated page in `directory` with its render. Reads only. */
export async function checkGeneratedDocs(directory = DOCS_DIRECTORY): Promise<readonly GeneratedDocStatus[]> {
  return await Promise.all(GENERATED_DOCS.map(async ({ file, render }): Promise<GeneratedDocStatus> => {
    const expected = Buffer.from(await render(), "utf8");
    let actual: Buffer;
    try {
      actual = readFileSync(join(directory, file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { file, status: "missing" };
      throw error;
    }
    return { file, status: actual.equals(expected) ? "current" : "different" };
  }));
}

/** Writes every generated page into `directory`. */
export async function writeGeneratedDocs(directory = DOCS_DIRECTORY): Promise<void> {
  for (const { file, render } of GENERATED_DOCS) writeFileSync(join(directory, file), await render(), { encoding: "utf8" });
}

if (import.meta.main) {
  Log.suppress();
  if (process.argv.includes("--check")) {
    const stale = (await checkGeneratedDocs()).filter(({ status }) => status !== "current");
    for (const { file, status } of stale) process.stderr.write(`generated-docs: src/workflows/docs/${file} is ${status}; run bun run docs:generate\n`);
    if (stale.length > 0) process.exit(1);
  } else {
    await writeGeneratedDocs();
  }
}
