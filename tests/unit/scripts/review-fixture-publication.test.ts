import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addedLines } from "../../../scripts/build-review-fixtures.js";
import { exposurePatterns, exposures, publishedDiffLines } from "../../../scripts/review-fixture-publication.js";
import { loadHarnessLint } from "../../../src/orchestration/modules/development/benchmark/harness-names.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();

// A lint in the shape of the maintainer's private one, with invented names.
const LINT = `export const HARNESS_TERMS: readonly RegExp[] = [
  /acmebot/i,
  /\\bwidgetcode\\b/i,
];

const WIRE_IDENTIFIERS: readonly RegExp[] = [
  /ACMEBOT_API_KEY/g,
];

export function findHarnessNames(_root: string, files: string[]): string[] {
  return files.filter((file) => /acmebot|widgetcode/i.test(require("node:fs").readFileSync(require("node:path").join(_root, file), "utf8")));
}
`;

describe("review fixture publication", () => {
  it("rewrites each harness name to its fixed neutral word, keeps wire identifiers, and counts the rewritten lines", async () => {
    const root = directory("review-publication-");
    writeFileSync(join(root, "lint.ts"), LINT);
    const lint = await loadHarnessLint(root, join(root, "lint.ts"));
    expect(lint?.scrub("Like Acmebot.\nset ACMEBOT_API_KEY\nwidgetcode and acmebot\nimport { acmebotModelId } from \"./x\";\nread(ACMEBOT_API_KEY); // for acmebot\n", (term) => `peerAgent${term + 1}`)).toEqual({
      text: "Like peerAgent1.\nset ACMEBOT_API_KEY\npeerAgent2 and peerAgent1\nimport { peerAgent1ModelId } from \"./x\";\nread(ACMEBOT_API_KEY); // for peerAgent1\n",
      lines: 4,
    });
    writeFileSync(join(root, "clean.md"), "peerAgent1\n");
    writeFileSync(join(root, "named.md"), "acmebot\n");
    expect(lint?.violations([join(root, "clean.md"), join(root, "named.md")])).toBe(1);
    expect(await loadHarnessLint(root, join(root, "absent.ts"))).toBeUndefined();
  });

  it("counts the lines that publish each private detail and ignores reserved email domains", () => {
    const patterns = exposurePatterns({ home: "/Users/pat", user: "pat", machines: ["patbox"], authProfiles: ["Home", "Pat Bench"], repositories: ["pat/secret-repo"] });
    const found = exposures(patterns, [
      "see /Users/pat/notes and patbox",
      "mail pat@corp.io, not ops@example.com",
      "FLYWHEEL_AUTH_PROFILE=Home bun run x",
      "run it on the auth profile Home",
      "use auth profile \"Pat Bench\"",
      "{ \"authProfile\": \"Home\" }",
      "auth_profile = 'Pat Bench'",
      "a home profile is not a profile name",
      "clone pat/secret-repo",
      "a .flywheel/sessions/0123456789ab/scratch path",
      "key sk-abcdefghijklmnopqrstuvwxyz",
      "write to ops@example.com only",
    ]);
    expect(Object.fromEntries(found)).toEqual({
      "home path": 1, "machine name": 1, email: 1, "auth profile": 5, "private repository": 1, "session path": 1, credential: 1,
    });
  });

  it("scans the diff lines that the pinned tree does not already publish", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n kept\n-old\n+new\n";
    expect([...publishedDiffLines(patch, () => new Set(["kept", "old"]))]).toEqual([
      "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", "+new", "",
    ]);
  });

  it("numbers the lines that a patch adds in the content after it", () => {
    expect([...addedLines("--- a\n+++ b\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+extra\n three\n@@ -9,1 +10,2 @@\n nine\n+ten\n")]).toEqual([2, 3, 11]);
  });
});
