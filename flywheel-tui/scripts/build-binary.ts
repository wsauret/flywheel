// Build a distributable tarball: compiled binary + assets + agent files.
//
// Usage:
//   bun run scripts/build-binary.ts                     # current platform
//   bun run scripts/build-binary.ts --target=bun-linux-x64  # cross-compile
//
// Output: dist/flywheel-<platform>-<arch>.tar.gz

import { $ } from "bun";
import { mkdir, readdir, copyFile, readFile, stat, cp, rm } from "fs/promises";
import { join, basename } from "path";
import solidPlugin from "@opentui/solid/bun-plugin";

import { writeManifest } from "./build-manifest.js";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const AGENTS_SRC = join(ROOT, "src", "workflows", "agents");

// Parse --target flag (e.g., --target=bun-linux-x64)
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg?.split("=")[1];

// Derive platform/arch for the tarball name
function getPlatformArch(): string {
  if (target) {
    // e.g. "bun-linux-x64" → "linux-x64"
    return target.replace(/^bun-/, "");
  }
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${arch}`;
}

const platformArch = getPlatformArch();
const stagingDir = join(DIST, `flywheel-${platformArch}`);
const agentsStagingDir = join(stagingDir, "agents");
const skillsStagingDir = join(stagingDir, "skills");
const runtimeStagingDir = join(stagingDir, "flywheel-runtime");
const runtimeNodeModulesDir = join(runtimeStagingDir, "node_modules");
const runtimePackages = [
  "sharp",
  "@img/colour",
  "detect-libc",
  "semver",
  `@img/sharp-${platformArch}`,
  `@img/sharp-libvips-${platformArch}`,
] as const;

// Step 0: Populate manifest.ts with real content (restored after bundling)
const manifestPath = join(AGENTS_SRC, "manifest.ts");
const manifestOriginal = await readFile(manifestPath, "utf-8");
console.log("Populating agent manifest...");
await writeManifest(manifestPath);

// Step 1: Bundle with Solid plugin
console.log("Bundling...");
const bundleResult = await Bun.build({
  entrypoints: [join(ROOT, "src", "cli", "index.ts")],
  outdir: DIST,
  target: "bun",
  plugins: [solidPlugin],
  conditions: ["browser"],
});

// Restore manifest.ts to its checked-in default
await Bun.write(manifestPath, manifestOriginal);

if (!bundleResult.success) {
  for (const log of bundleResult.logs) console.error(log);
  process.exit(1);
}
console.log(`  ${bundleResult.outputs.length} file(s) bundled`);

// Step 2: Compile bundle into standalone binary
console.log("Compiling standalone binary...");
const compileArgs = [
  "bun",
  "build",
  "--compile",
  join(DIST, "index.js"),
  "--outfile",
  join(stagingDir, "flywheel"),
];
if (target) compileArgs.push(`--target=${target}`);

const compileProc = Bun.spawn(compileArgs, { stdout: "inherit", stderr: "inherit" });
const compileExit = await compileProc.exited;
if (compileExit !== 0) {
  console.error("Compile failed");
  process.exit(1);
}

// Bun leaves a malformed LC_CODE_SIGNATURE — strip it, then ad-hoc sign
if (process.platform === "darwin" && !target) {
  console.log("Signing binary (ad-hoc)...");
  const binaryPath = join(stagingDir, "flywheel");
  const strip = Bun.spawn(["codesign", "--remove-signature", binaryPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await strip.exited) !== 0) {
    console.error("Failed to strip signature");
    process.exit(1);
  }
  const sign = Bun.spawn(["codesign", "--sign", "-", "--force", binaryPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await sign.exited) !== 0) {
    console.error("Ad-hoc signing failed");
    process.exit(1);
  }
}

// Step 3: Copy assets (wasm, scm) into staging
console.log("Copying assets...");
const distEntries = await readdir(DIST);
const assetExts = [".wasm", ".scm"];
for (const entry of distEntries) {
  if (assetExts.some((ext) => entry.endsWith(ext))) {
    await copyFile(join(DIST, entry), join(stagingDir, entry));
  }
}

// Step 4: Copy agent persona files. Tarball ships the canonical sources;
// install.sh stages them so the running TS installer can project per
// destination (Claude vs harness) on app startup.
console.log("Copying agent files...");
await mkdir(agentsStagingDir, { recursive: true });
const personaDir = join(AGENTS_SRC, "personas", "fly");
const personaFiles = (await readdir(personaDir)).filter((f) => f.endsWith(".md"));
for (const file of personaFiles) {
  await copyFile(join(personaDir, file), join(agentsStagingDir, file));
}

// Step 5: Copy skill files
const skillsSourceDir = join(AGENTS_SRC, "skills");
const skillEntries = await readdir(skillsSourceDir, { withFileTypes: true });
for (const entry of skillEntries) {
  if (!entry.isDirectory()) continue;
  const skillName = entry.name;
  const skillSrc = join(skillsSourceDir, skillName);
  const skillDest = join(skillsStagingDir, skillName);
  await mkdir(skillDest, { recursive: true });

  // SKILL.md
  const skillMd = join(skillSrc, "SKILL.md");
  try {
    await stat(skillMd);
    await copyFile(skillMd, join(skillDest, "SKILL.md"));
  } catch {
    // No SKILL.md — skip
  }

  // references/
  const refsDir = join(skillSrc, "references");
  try {
    const refs = (await readdir(refsDir)).filter((f) => f.endsWith(".md"));
    if (refs.length > 0) {
      const refsDest = join(skillDest, "references");
      await mkdir(refsDest, { recursive: true });
      for (const ref of refs) {
        await copyFile(join(refsDir, ref), join(refsDest, ref));
      }
    }
  } catch {
    // No references — fine
  }
}

// Step 6: Copy sharp runtime packages
console.log("Copying sharp runtime...");
await rm(runtimeStagingDir, { recursive: true, force: true });
await mkdir(runtimeNodeModulesDir, { recursive: true });
for (const packageName of runtimePackages) {
  await copyRuntimePackage(packageName);
}
await patchVendoredSharpRuntime();

// Step 7: Generate install script
console.log("Generating install script...");
const installScript = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="\${FLYWHEEL_INSTALL_DIR:-\$HOME/.local/bin}"
CLAUDE_DIR="\$HOME/.claude"

echo ""
echo "  flywheel installer"
echo ""

# --- Check for Claude Code ---
if ! command -v claude &>/dev/null; then
  echo "  Claude Code is required but not installed."
  echo ""
  if command -v npm &>/dev/null; then
    read -rp "  Install it now? [Y/n] " yn
    yn="\${yn:-Y}"
    if [[ "\$yn" =~ ^[Yy] ]]; then
      echo "  Installing Claude Code..."
      npm install -g @anthropic-ai/claude-code
      echo ""
      echo "  Run 'claude' to authenticate, then re-run this installer."
      exit 0
    else
      echo "  Install Claude Code manually: npm install -g @anthropic-ai/claude-code"
      exit 1
    fi
  else
    echo "  Install Node.js first, then: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
fi

# --- Check Claude Code is authenticated ---
if ! claude --version &>/dev/null; then
  echo "  Claude Code is installed but may not be authenticated."
  echo "  Run 'claude' to authenticate, then re-run this installer."
  exit 1
fi

# --- Install binary + assets ---
mkdir -p "\$INSTALL_DIR"
rm -f "\$INSTALL_DIR/flywheel"
cp "\$SCRIPT_DIR/flywheel" "\$INSTALL_DIR/flywheel"
chmod +x "\$INSTALL_DIR/flywheel"

if [ -d "\$SCRIPT_DIR/flywheel-runtime" ]; then
  rm -rf "\$INSTALL_DIR/flywheel-runtime"
  cp -R "\$SCRIPT_DIR/flywheel-runtime" "\$INSTALL_DIR/flywheel-runtime"
fi

# Re-sign at install location (macOS caches Gatekeeper assessments per-path)
if [[ "\$(uname)" == "Darwin" ]]; then
  codesign --remove-signature "\$INSTALL_DIR/flywheel" 2>/dev/null
  codesign --sign - --force "\$INSTALL_DIR/flywheel" 2>/dev/null
fi

for f in "\$SCRIPT_DIR"/*.wasm "\$SCRIPT_DIR"/*.scm; do
  [ -f "\$f" ] && cp "\$f" "\$INSTALL_DIR/"
done

# --- Install skills (agents are projected by the binary at first launch) ---
if [ -d "\$SCRIPT_DIR/skills" ]; then
  for skill_dir in "\$SCRIPT_DIR/skills"/*/; do
    skill_name="\$(basename "\$skill_dir")"
    dest="\$CLAUDE_DIR/skills/\$skill_name"
    mkdir -p "\$dest"
    [ -f "\$skill_dir/SKILL.md" ] && cp "\$skill_dir/SKILL.md" "\$dest/"
    if [ -d "\$skill_dir/references" ]; then
      mkdir -p "\$dest/references"
      cp "\$skill_dir/references/"*.md "\$dest/references/" 2>/dev/null || true
    fi
  done
fi

# --- Add to PATH if needed ---
if ! echo "\$PATH" | tr ':' '\\n' | grep -qx "\$INSTALL_DIR"; then
  SHELL_NAME="\$(basename "\$SHELL")"
  case "\$SHELL_NAME" in
    zsh)  PROFILE="\$HOME/.zshrc" ;;
    bash) PROFILE="\$HOME/.bashrc" ;;
    *)    PROFILE="\$HOME/.profile" ;;
  esac

  echo "" >> "\$PROFILE"
  echo "export PATH=\\"\$INSTALL_DIR:\\\$PATH\\"" >> "\$PROFILE"
  echo "  Added \$INSTALL_DIR to PATH in \$PROFILE"
  export PATH="\$INSTALL_DIR:\$PATH"
fi

echo "  Installed. Open a new terminal and run: flywheel"
echo ""
`;
await Bun.write(join(stagingDir, "install.sh"), installScript);
await $`chmod +x ${join(stagingDir, "install.sh")}`;

// Step 8: Create tarball
console.log("Creating tarball...");
const tarball = `flywheel-${platformArch}.tar.gz`;
await $`tar -czf ${join(DIST, tarball)} -C ${DIST} ${basename(stagingDir)}`;

// Summary
const tarballStat = await stat(join(DIST, tarball));
const sizeMB = (tarballStat.size / 1024 / 1024).toFixed(1);
console.log(`\nBuild complete: dist/${tarball} (${sizeMB} MB)`);
console.log(`  Binary:  flywheel (standalone + vendored sharp runtime)`);
console.log(`  Assets:  ${assetExts.map((e) => `*${e}`).join(", ")}`);
console.log(`  Agents:  ${personaFiles.length} persona(s)`);
console.log(`  Install: tar xzf ${tarball} && cd ${basename(stagingDir)} && ./install.sh`);

async function copyRuntimePackage(packageName: string): Promise<void> {
  const segments = packageName.split("/");
  const source = join(ROOT, "node_modules", ...segments);
  const destination = join(runtimeNodeModulesDir, ...segments);
  const destinationParent = join(runtimeNodeModulesDir, ...segments.slice(0, -1));

  try {
    await mkdir(destinationParent, { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Missing sharp runtime package ${packageName}: ${error}`);
  }
}

async function patchVendoredSharpRuntime(): Promise<void> {
  const patches = [
    { file: join(runtimeNodeModulesDir, "sharp", "lib", "colour.js"), replacements: [["require(\x27@img/colour\x27)", "require(\x27../../@img/colour/index.cjs\x27)"]] },
    { file: join(runtimeNodeModulesDir, "sharp", "lib", "utility.js"), replacements: [["require(\x27detect-libc\x27)", "require(\x27../../detect-libc/lib/detect-libc.js\x27)"], ["require(`@img/sharp-${runtimePlatform}/versions`)", "require(`../../@img/sharp-libvips-${runtimePlatform}/versions.json`)"]] },
    { file: join(runtimeNodeModulesDir, "sharp", "lib", "sharp.js"), replacements: [["require(\x27detect-libc\x27)", "require(\x27../../detect-libc/lib/detect-libc.js\x27)"], ["`@img/sharp-${runtimePlatform}/sharp.node`", "`../../@img/sharp-${runtimePlatform}/lib/sharp-${runtimePlatform}.node`"], ["\x27@img/sharp-wasm32/sharp.node\x27", "\x27../../@img/sharp-wasm32/sharp.node\x27"], ["path.startsWith(\x27@img/sharp-linux-x64\x27)", "path.includes(\x27sharp-linux-x64\x27)"], ["require(`@img/sharp-libvips-${runtimePlatform}/package`)", "require(`../../@img/sharp-libvips-${runtimePlatform}/package.json`)"]] },
    { file: join(runtimeNodeModulesDir, "sharp", "lib", "libvips.js"), replacements: [["require(\x27semver/functions/coerce\x27)", "require(\x27../../semver/functions/coerce.js\x27)"], ["require(\x27semver/functions/gte\x27)", "require(\x27../../semver/functions/gte.js\x27)"], ["require(\x27semver/functions/satisfies\x27)", "require(\x27../../semver/functions/satisfies.js\x27)"], ["require(\x27detect-libc\x27)", "require(\x27../../detect-libc/lib/detect-libc.js\x27)"]] },
  ] as const;

  for (const patch of patches) {
    let content = await readFile(patch.file, "utf-8");
    for (const [oldText, newText] of patch.replacements) {
      if (!content.includes(oldText)) throw new Error(`Missing vendored sharp snippet in ${patch.file}: ${oldText}`);
      content = content.replace(oldText, newText);
    }
    await Bun.write(patch.file, content);
  }
}

