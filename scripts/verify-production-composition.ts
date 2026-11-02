import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { hostBinaryPath } from "./binary-native-assets.js";

interface StringEnvironment {
  [key: string]: string;
}

const ProbeOutputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  evidence: Schema.Struct({
    buildKind: Schema.Union([Schema.Literal("source"), Schema.Literal("compiled")]),
    bundledSourceKinds: Schema.Array(Schema.Union([Schema.Literal("filesystem"), Schema.Literal("manifest")])),
  }),
  composition: Schema.Unknown,
});

const ROOT = join(import.meta.dir, "..");

type VerifierArguments = { readonly mode: "standalone" } | { readonly mode: "binary"; readonly path: string };

export function parseVerifierArguments(args: readonly string[]): VerifierArguments {
  if (args.length === 0) return { mode: "standalone" };
  if (args[0] === "--binary" && args.length === 2) {
    const path = args[1];
    if (path) return { mode: "binary", path };
    throw new Error("--binary requires a path");
  }
  if (args[0] === "--binary" && args.length === 1) throw new Error("--binary requires a path");
  throw new Error("Usage: bun run scripts/verify-production-composition.ts [--binary <path>]");
}

async function run(command: readonly string[], env: StringEnvironment): Promise<string> {
  const process = Bun.spawn([...command], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exit !== 0) throw new Error(`${command.join(" ")} exited ${exit}${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
  return stdout.trim();
}

function parseProbeOutput(text: string): typeof ProbeOutputSchema.Type {
  return Schema.decodeUnknownSync(ProbeOutputSchema)(JSON.parse(text));
}

/** Bytes a release must not carry: the development module's descriptor and
 *  its definition bundle. The descriptor is named by its settings copy and
 *  the bundle by the manifest key of one skill package. Each marker
 *  identifies embedded development content, not prose about the module. Bun's
 *  bundler keeps a statically imported catalog even behind a build-time
 *  constant, so the exclusion is a property of the entry, and this is where
 *  it is proved. */
export const DEVELOPMENT_BUILD_MARKERS: readonly string[] = [
  "Flywheel's own benchmark, simulator, and report tooling",
  "flywheel-uat/SKILL.md",
];

/** The development markers a build carries, in marker order. */
export function findDevelopmentMarkers(build: Uint8Array): readonly string[] {
  const bytes = Buffer.from(build.buffer, build.byteOffset, build.byteLength);
  return DEVELOPMENT_BUILD_MARKERS.filter((marker) => bytes.includes(marker));
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseVerifierArguments(args);
  const owned = await mkdtemp(join(tmpdir(), "flywheel-composition-probe-"));
  try {
    const home = join(owned, "home");
    const project = join(owned, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    const inherited: StringEnvironment = {};
    for (const [key, value] of Object.entries(Bun.env)) {
      if (key !== "FLYWHEEL_PROJECT_ROOT" && value !== undefined) inherited[key] = value;
    }
    const env = { ...inherited, HOME: home, USERPROFILE: home, FLYWHEEL_INTERNAL_COMPOSITION_PROBE: "1" };
    if (options.mode === "standalone") await run(["bun", "run", "build:binary"], env);
    const source = parseProbeOutput(await run(["bun", "--conditions=browser", "run", "src/cli/index.ts", "--project-root", project], env));
    const binary = options.mode === "binary" ? options.path : hostBinaryPath(ROOT);
    const carried = findDevelopmentMarkers(await Bun.file(binary).bytes());
    if (carried.length > 0) throw new Error(`Release build carries the development module: ${carried.map((marker) => JSON.stringify(marker)).join(", ")}`);
    const compiled = parseProbeOutput(await run([binary, "--project-root", project], env));
    if (source.evidence.buildKind !== "source" || JSON.stringify(source.evidence.bundledSourceKinds) !== '["filesystem"]') {
      throw new Error(`Source probe provenance was ${JSON.stringify(source.evidence)}`);
    }
    if (compiled.evidence.buildKind !== "compiled" || JSON.stringify(compiled.evidence.bundledSourceKinds) !== '["manifest"]') {
      throw new Error(`Compiled probe provenance was ${JSON.stringify(compiled.evidence)}`);
    }
    const sourceComposition = JSON.stringify(source.composition);
    const compiledComposition = JSON.stringify(compiled.composition);
    if (sourceComposition !== compiledComposition) {
      throw new Error(`Production composition mismatch: source=${sourceComposition.length} bytes compiled=${compiledComposition.length} bytes`);
    }
    console.log("Production source and compiled composition match.");
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(process.argv.slice(2));