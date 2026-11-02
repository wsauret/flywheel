import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLYWHEEL_FONT_FAMILY,
  fontTipMessage,
  getFontStatus,
  installBundledFont,
} from "../../../src/orchestration/font-installer.js";
import { type AccountDirectories, FLYWHEEL_DIR_NAME } from "../../../src/infra/directory-authorities.js";
import { fakeOwnedCommandRunner } from "../../helpers/owned-command-fake.js";

const FONT_FILES = [
  "MonaspaceArgon-Regular.otf",
  "MonaspaceArgon-Bold.otf",
  "MonaspaceArgon-Italic.otf",
  "MonaspaceArgon-BoldItalic.otf",
] as const;

let tmpDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flywheel-font-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** The account authorities a case publishes for its own temporary home, so the
 *  font directories and the global config never reach the developer's account. */
function account(accountHome: string): AccountDirectories {
  return { accountHome, userDataRoot: join(accountHome, FLYWHEEL_DIR_NAME) };
}

async function seedSource(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of FONT_FILES) await writeFile(join(dir, file), file);
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

describe("font installer", () => {
  test("installs bundled font files to the Linux user font directory", async () => {
    const accountHome = await tempDir();
    const sourceDir = await tempDir();
    await seedSource(sourceDir);

    const result = await installBundledFont({
      platform: "linux",
      ...account(accountHome),
      sourceDir,
      refreshSystemCache: false,
    }, fakeOwnedCommandRunner());

    expect(result.status.installed).toBe(true);
    expect(result.targetDir).toBe(join(accountHome, ".local", "share", "fonts", "flywheel"));
    for (const file of FONT_FILES) expect(existsSync(join(result.targetDir, file))).toBe(true);
  });

  test("reports source availability separately from installed status", async () => {
    const accountHome = await tempDir();
    const sourceDir = await tempDir();
    await seedSource(sourceDir);

    const status = getFontStatus({ platform: "darwin", ...account(accountHome), sourceDir });

    expect(status.installed).toBe(false);
    expect(status.installable).toBe(true);
    expect(status.targetDir).toBe(join(accountHome, "Library", "Fonts"));
  });

  test("font tip formatting uses the projected dismissal value", async () => {
    const accountHome = await tempDir();
    const sourceDir = await tempDir();
    await seedSource(sourceDir);
    const options = { platform: "linux" as const, ...account(accountHome), sourceDir };

    expect(fontTipMessage(false, options)).toContain("/font install");
    expect(fontTipMessage(true, options)).toBeNull();
  });

  test("tip changes from install guidance to terminal selection guidance after install", async () => {
    const accountHome = await tempDir();
    const sourceDir = await tempDir();
    await tempDir();
    await seedSource(sourceDir);

    await installBundledFont({ platform: "linux", ...account(accountHome), sourceDir, refreshSystemCache: false }, fakeOwnedCommandRunner());

    expect(fontTipMessage(false, { platform: "linux", ...account(accountHome), sourceDir })).toContain(
      `Choose ${FLYWHEEL_FONT_FAMILY}`,
    );
  });
});
