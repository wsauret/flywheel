import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceCheckout } from "../infra/cli-subprocess.js";
import type { OwnedCommandRunner } from "../infra/owned-command.js";

export const FLYWHEEL_FONT_FAMILY = "Monaspace Argon";

const FONT_FILES = [
  "MonaspaceArgon-Regular.otf",
  "MonaspaceArgon-Bold.otf",
  "MonaspaceArgon-Italic.otf",
  "MonaspaceArgon-BoldItalic.otf",
] as const;

interface WindowsRegistryNames {
  "MonaspaceArgon-Regular.otf": string;
  "MonaspaceArgon-Bold.otf": string;
  "MonaspaceArgon-Italic.otf": string;
  "MonaspaceArgon-BoldItalic.otf": string;
}

interface FontEnvironment {
  [name: string]: string | undefined;
}

const WINDOWS_REGISTRY_NAMES: WindowsRegistryNames = {
  "MonaspaceArgon-Regular.otf": "Monaspace Argon Regular (OpenType)",
  "MonaspaceArgon-Bold.otf": "Monaspace Argon Bold (OpenType)",
  "MonaspaceArgon-Italic.otf": "Monaspace Argon Italic (OpenType)",
  "MonaspaceArgon-BoldItalic.otf": "Monaspace Argon Bold Italic (OpenType)",
};

export interface FontOptions {
  /** Startup-selected account home. The platform font directories derive from
   *  it (ARCH-DIRECTORIES-002); this module resolves no account path of its own. */
  readonly accountHome: string;
  /** Startup-selected account data root containing bundled font assets. */
  readonly userDataRoot: string;
  readonly configPath?: string;
  platform?: NodeJS.Platform;
  env?: FontEnvironment;
  sourceDir?: string;
  refreshSystemCache?: boolean;
}

/** What an install needs beyond its options: the owned command the font cache
 *  refresh and the Windows registry write run as. Separate from `FontOptions`
 *  because every read-only status call needs none of it. */
export interface FontInstallDeps {
  readonly run: OwnedCommandRunner;
}

interface FontStatus {
  installed: boolean;
  installedFiles: string[];
  missingFiles: string[];
  sourceDir: string | null;
  targetDir: string;
  installable: boolean;
}

interface FontInstallResult {
  status: FontStatus;
  installedFiles: string[];
  targetDir: string;
  warnings: string[];
}

function platform(options: FontOptions): NodeJS.Platform {
  return options.platform ?? process.platform;
}

function homeDir(options: FontOptions): string {
  return options.accountHome;
}

function env(options: FontOptions): FontEnvironment {
  return options.env ?? process.env;
}

function sourceCandidates(options: FontOptions): string[] {
  if (options.sourceDir) return [options.sourceDir];
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const argvDir = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  return [
    resolve(sourceCheckout(), "assets/fonts/monaspace-argon"),
    resolve(moduleDir, "../assets/fonts/monaspace-argon"),
    ...(argvDir ? [resolve(argvDir, "fonts/monaspace-argon")] : []),
    resolve(dirname(process.execPath), "fonts/monaspace-argon"),
  ];
}

function findSourceDir(options: FontOptions): string | null {
  for (const candidate of sourceCandidates(options)) {
    if (FONT_FILES.every((file) => existsSync(join(candidate, file)))) return candidate;
  }
  return null;
}

function targetDir(options: FontOptions): string {
  const home = homeDir(options);
  const vars = env(options);
  switch (platform(options)) {
    case "darwin":
      return join(home, "Library", "Fonts");
    case "win32":
      return join(vars.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts");
    default:
      return join(home, ".local", "share", "fonts", "flywheel");
  }
}

function installedDirs(options: FontOptions): string[] {
  const home = homeDir(options);
  const vars = env(options);
  switch (platform(options)) {
    case "darwin":
      return [targetDir(options), "/Library/Fonts"];
    case "win32":
      return [targetDir(options), join(vars.WINDIR ?? "C:\\Windows", "Fonts")];
    default:
      return [
        targetDir(options),
        join(home, ".local", "share", "fonts"),
        "/usr/local/share/fonts",
        "/usr/share/fonts",
      ];
  }
}

function installedPathFor(file: string, options: FontOptions): string | null {
  for (const dir of installedDirs(options)) {
    for (const candidate of [join(dir, file), join(dir, "flywheel", file)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function getFontStatus(options: FontOptions): FontStatus {
  const installedFiles = FONT_FILES.filter((file) => installedPathFor(file, options));
  const missingFiles = FONT_FILES.filter((file) => !installedFiles.includes(file));
  const sourceDir = findSourceDir(options);
  return {
    installed: missingFiles.length === 0,
    installedFiles,
    missingFiles,
    sourceDir,
    targetDir: targetDir(options),
    installable: sourceDir !== null,
  };
}

async function refreshLinuxFontCache(dir: string, warnings: string[], run: OwnedCommandRunner): Promise<void> {
  if (!Bun.which("fc-cache")) {
    warnings.push("fc-cache was not found; restart terminal apps if the font does not appear.");
    return;
  }
  const result = await run(["fc-cache", "-f", dir]);
  if (result.exitCode !== 0) {
    warnings.push(`fc-cache failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

async function registerWindowsFonts(dir: string, warnings: string[], run: OwnedCommandRunner): Promise<void> {
  const registryKey = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
  for (const file of FONT_FILES) {
    const valueName = WINDOWS_REGISTRY_NAMES[file];
    const result = await run([
      "reg",
      "add",
      registryKey,
      "/v",
      valueName,
      "/t",
      "REG_SZ",
      "/d",
      join(dir, file),
      "/f",
    ]);
    if (result.exitCode !== 0) warnings.push(`Windows font registration failed for ${file}: ${result.stderr.trim()}`);
  }
}

export async function installBundledFont(options: FontOptions, deps: FontInstallDeps): Promise<FontInstallResult> {
  const sourceDir = findSourceDir(options);
  if (!sourceDir) throw new Error("Bundled Monaspace Argon font files were not found.");

  const destDir = targetDir(options);
  mkdirSync(destDir, { recursive: true });
  for (const file of FONT_FILES) {
    copyFileSync(join(sourceDir, file), join(destDir, file));
  }

  const warnings: string[] = [];
  if (options.refreshSystemCache !== false) {
    if (platform(options) === "linux") await refreshLinuxFontCache(destDir, warnings, deps.run);
    if (platform(options) === "win32") await registerWindowsFonts(destDir, warnings, deps.run);
  }

  return {
    status: getFontStatus(options),
    installedFiles: [...FONT_FILES],
    targetDir: destDir,
    warnings,
  };
}


export function fontStatusSummary(status: FontStatus): string {
  if (status.installed) {
    return `${FLYWHEEL_FONT_FAMILY} is installed. Set your terminal profile font to ${FLYWHEEL_FONT_FAMILY}.`;
  }
  if (!status.installable) return "Bundled Monaspace Argon font files were not found.";
  return `Monaspace Argon is not installed. Run /font install or flywheel font install.`;
}

export function fontInstallSummary(result: FontInstallResult): string {
  const warning = result.warnings[0];
  if (warning) return `Installed ${FLYWHEEL_FONT_FAMILY}; ${warning}`;
  return `Installed ${FLYWHEEL_FONT_FAMILY}. Set your terminal font to ${FLYWHEEL_FONT_FAMILY}.`;
}

export function fontTipMessage(dismissed: boolean, options: FontOptions): string | null {
  if (dismissed) return null;
  const status = getFontStatus(options);
  if (status.installed) {
    return `Tip: Choose ${FLYWHEEL_FONT_FAMILY} in your terminal. /font dismiss`;
  }
  if (!status.installable) return null;
  return `Tip: Run /font install for ${FLYWHEEL_FONT_FAMILY}, then choose it in your terminal. /font dismiss`;
}
