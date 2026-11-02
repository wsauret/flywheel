import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowAssets as manifestWorkflowAssets, type WorkflowAssets } from "./agents/manifest.js";

/** Where a definition file lives. The core root is Flywheel's own workflow
 *  folder, `src/workflows/workflows/`, in a source run and in the compiled
 *  binary alike. A directory root is a folder on disk: a module bundle's
 *  `workflows/` folder, or the account's or project's own workflow folder. */
type AssetRoot = { readonly kind: "core" } | { readonly kind: "directory"; readonly dir: string };

/** One definition file: a root and a normalized POSIX path relative to it. */
export interface AssetLocation {
  readonly root: AssetRoot;
  readonly path: string;
}

/** The prefix that names a path in the core root from any definition layer. */
const BUNDLED_PREFIX = "bundled:";

/** The core workflow folder in a source run. */
const coreWorkflowsDir = fileURLToPath(new URL("workflows", import.meta.url));

/** The manifest keys the core root occupies. The build keys every embedded
 *  file relative to `src/workflows/`, so the core root is `workflows/`. */
const CORE_MANIFEST_PREFIX = "workflows/";

/** The file types a definition file can be: workflows, briefs, and
 *  output contracts. The build embeds exactly these, so a source run lists
 *  exactly these too.
 *
 *  @public
 *  `scripts/build-manifest.ts` reads this list to embed the definition files.
 *  Knip does not trace scripts into the project, so this export is not dead. */
export const DEFINITION_ASSET_EXTENSIONS = [".md", ".yaml", ".yml", ".json"] as const;

function isDefinitionAsset(path: string): boolean {
  return DEFINITION_ASSET_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Why a path that a definition author wrote cannot name a file, or
 *  undefined when it can. Paths are POSIX only on every platform, so a
 *  Windows path is refused here rather than read differently per platform. */
function authoredPathProblem(path: string): string | undefined {
  if (path === "") return "must not be empty";
  if (path.includes("\\")) return "must use forward slashes; a backslash is not allowed";
  if (/^[A-Za-z]:/u.test(path)) return "must not start with a drive prefix";
  if (path.startsWith("/")) return "must be relative, not absolute";
  return undefined;
}

/** Whether an authored path names a file in the core root. Such a path
 *  resolves the same from every file, and from a definition with no file. */
export function isBundledAssetRef(ref: string): boolean {
  return ref.startsWith(BUNDLED_PREFIX);
}

/** Resolve a path that the file at `from` wrote. `bundled:<path>` names a
 *  file in the core root, and needs no `from`. Any other path is relative to
 *  the folder of the file that wrote it, in the same root, so it throws
 *  without `from`. A path that leaves its root throws, because a definition
 *  layer reads only its own files. */
export function resolveAssetRef(from: AssetLocation | undefined, ref: string): AssetLocation {
  const bundled = isBundledAssetRef(ref);
  const authored = bundled ? ref.slice(BUNDLED_PREFIX.length) : ref;
  const problem = authoredPathProblem(authored);
  if (problem) throw new Error(`Path ${JSON.stringify(ref)} ${problem}`);
  const base = bundled ? undefined : from;
  if (!bundled && base === undefined) throw new Error(`Path ${JSON.stringify(ref)} is relative, and its definition has no file location to resolve it from`);
  const root: AssetRoot = base === undefined ? { kind: "core" } : base.root;
  const path = base === undefined ? posix.normalize(authored) : posix.join(posix.dirname(base.path), authored);
  if (path === ".." || path.startsWith("../")) throw new Error(`Path ${JSON.stringify(ref)} leaves the root of its definition layer`);
  if (path === "." || path.endsWith("/")) throw new Error(`Path ${JSON.stringify(ref)} does not name a file`);
  return { root, path };
}

/** A name for a location in a load error. */
export function describeAsset(location: AssetLocation): string {
  return location.root.kind === "core"
    ? `${BUNDLED_PREFIX}${location.path}`
    : join(location.root.dir, ...location.path.split("/"));
}

/** Reads definition files. The core root comes from one source for the
 *  whole process: the embedded manifest when the build filled it, else the
 *  source tree. A compiled binary therefore never falls back to the disk, and
 *  a source run never reads a stale manifest. */
export interface DefinitionAssetReader {
  read(location: AssetLocation): string;
  /** Every file of the core root as a sorted POSIX path relative to it. */
  listCoreFiles(): readonly string[];
}

function filesBelow(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A source tree without the core folder carries no core definitions.
    return [];
  }
  return entries.flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesBelow(join(dir, entry.name), path);
    return entry.isFile() ? [path] : [];
  });
}

/** Build a reader over one manifest. Production uses {@link definitionAssets};
 *  a test passes a manifest to read as the compiled binary does.
 *
 *  Both modes read the core root the same way. A core path must match a
 *  listed core file exactly, case included, and only definition file types
 *  are listed. A source run on a case-insensitive file system therefore
 *  refuses the same path that the binary refuses. */
export function createDefinitionAssetReader(manifest: WorkflowAssets, coreDir: string = coreWorkflowsDir): DefinitionAssetReader {
  const manifestMode = Object.keys(manifest).length > 0;
  const listCoreFiles = (): readonly string[] => (manifestMode
    ? Object.keys(manifest).filter((key) => key.startsWith(CORE_MANIFEST_PREFIX)).map((key) => key.slice(CORE_MANIFEST_PREFIX.length))
    : filesBelow(coreDir)
  ).filter(isDefinitionAsset).sort();
  const readCore = (path: string): string => {
    // A source run lists the tree again on each read, so a file added during
    // the session loads on the next reload, as an edited file does.
    const content = !listCoreFiles().includes(path) ? undefined
      : manifestMode ? manifest[`${CORE_MANIFEST_PREFIX}${path}`]
      : readFileSync(join(coreDir, ...path.split("/")), "utf8");
    if (content === undefined) throw new Error(`Bundled definition file ${BUNDLED_PREFIX}${path} is not in this build`);
    return content;
  };
  return {
    read: (location) => location.root.kind === "core"
      ? readCore(location.path)
      : readFileSync(join(location.root.dir, ...location.path.split("/")), "utf8"),
    listCoreFiles,
  };
}

/** The process reader. */
export const definitionAssets: DefinitionAssetReader = createDefinitionAssetReader(manifestWorkflowAssets);
