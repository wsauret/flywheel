import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bytesIdentity, directoryIdentity, structuredIdentity } from "./content-identity.js";
import { loadImplementTasks, PLAN_FILE, type ImplementTaskSpec } from "./implement-task.js";
import { immutableGitObjectSelector, objectValue, type CommitSnapshot } from "./task-schema.js";
import { containedPath, isPresent, realDirectoryUnder, realFileUnder } from "./paths.js";

/** What a persona's cells produce and how they are scored. */
export const BENCHMARK_MODES = ["research", "reviewer", "implement"] as const;
export type BenchmarkMode = typeof BENCHMARK_MODES[number];

export const DEFAULT_IMPLEMENTER_TIMEOUT_MS = 25 * 60 * 1_000;

export interface BenchmarkTask {
  id: string;
  prompt: string;
  contentIdentity: string;
}

/** A research task studies the benchmarked project itself, so its trial reads
 *  `snapshot`, a pinned commit restricted to an explicit path list. */
export interface ResearchTask extends BenchmarkTask {
  snapshot: CommitSnapshot;
}

export interface ReviewDefect {
  id: string;
  title: string;
  category: string;
  files: readonly string[];
  catch_criteria: string;
  /** The model whose recorded review reported this defect. Fixtures built from
   *  real reviews carry it; hand-authored fixtures do not. */
  finder?: string;
  /** Whether curation accepted this label. A built fixture drafts every label
   *  as false, and the loader refuses a fixture until each one is accepted or
   *  removed; a hand-authored label carries no field and counts as accepted. */
  accepted?: boolean;
}

/** A manifest with no defects is a control: a reviewed change that no review
 *  found anything in. */
export interface ReviewManifest {
  title: string;
  defects: readonly ReviewDefect[];
  review_prompt_hint: string;
}

/** Size class of the reviewed change, from the changed lines of `diff.patch`.
 *  A plan review has no diff. */
type ReviewStratum = "S1" | "S2" | "S3" | "S4" | "plan";

/** The upper bound of changed lines for each diff stratum; above the last is S4. */
const STRATUM_BOUNDS: readonly (readonly [Exclude<ReviewStratum, "S4" | "plan">, number])[] = [["S1", 50], ["S2", 200], ["S3", 600]];

/** Where a review sandbox's files come from: the fixture's vendored `project/`
 *  directory, or a commit of this repository with the reviewed diff applied to
 *  its working tree. */
export type ReviewSource = { readonly kind: "project" } | { readonly kind: "commit"; readonly commit: string };

/** A review task reviews one change in a sandbox that holds every file the
 *  reviewer reads, so a clone of the repository that holds the fixture can run it. */
export interface ReviewTask extends BenchmarkTask {
  fixtureDir: string;
  manifest: ReviewManifest;
  /** Reviewed artifact: a code diff or an implementation plan. A project source
   *  copies it into the sandbox root; a commit source applies the diff to the
   *  working tree instead. */
  artifact: "diff.patch" | "plan.md";
  source: ReviewSource;
  stratum: ReviewStratum;
}

/** An implementation task plus the direct subagent assignment and a bounded runtime. */
export type ImplementTask = ImplementTaskSpec & BenchmarkTask & { timeoutMs: number };

type BenchmarkTaskSource = Pick<BenchmarkTask, "id" | "prompt">;

interface TasksByPersona {
  readonly [persona: string]: readonly BenchmarkTaskSource[];
}

/** The one project view every research trial reads. A research task studies
 *  the benchmarked project, so its corpus is pinned like its prompt: an include
 *  list keeps earlier results, benchmark fixtures, and archives out, and a
 *  fixed commit keeps every campaign comparable while the live tree moves.
 *  Prompts that name files name them as they exist at this commit. */
export const RESEARCH_SNAPSHOT: CommitSnapshot = {
  commit: immutableGitObjectSelector("85c69871d53e3f1dba2532773dd7db38a93c41b3", "RESEARCH_SNAPSHOT.commit"),
  paths: ["src", "AGENTS.md", "docs/architecture.md", "docs/architecture-intent", "docs/product-intent", "docs/terminology.md"],
};

/** Why a stored research campaign no longer matches the current suite. The pin
 *  is part of each research task, so a campaign whose answers were produced
 *  against another corpus, including the unpinned checkout before the pin,
 *  can be neither resumed nor rescored: its report would mix two corpora. */
export const RESEARCH_TASKS_CHANGED = "Benchmark campaign identity changed: its research tasks do not match the current suite, which reads the corpus pinned by RESEARCH_SNAPSHOT. A campaign created before that pin, or under another pin or other prompts, is read-only evidence; start a new campaign";

/** Read-only explorer research tasks, all reading RESEARCH_SNAPSHOT. */
const TASKS_BY_PERSONA: TasksByPersona = {
  explorer: [
    {
      id: "session-disposal",
      prompt: "How does session disposal ordering work and what are the data-loss boundaries?",
    },
    {
      id: "model-effort-resolution",
      prompt: "Trace how a workflow agent's model and effort are resolved from config to the provider request.",
    },
    {
      id: "streaming-output",
      prompt: "How does the TUI receive and render streaming output blocks from the runtime?",
    },
  ],
};

/** The fixture members one review cell reads into its sandbox. A commit source
 *  has no project directory. */
type ReviewFixturePaths =
  | { readonly kind: "project"; readonly artifactPath: string; readonly projectDir: string }
  | { readonly kind: "commit"; readonly artifactPath: string; readonly commit: string };

type ReviewFixtureDescriptor = Pick<ReviewTask, "id" | "fixtureDir" | "artifact" | "source">;

/** Resolve the fixture members of one review task, refusing anything that is not
 *  a real file or directory inside the fixtures root.
 *
 *  A fixture member is on disk and can change between the catalog load that
 *  first checked it and the copy that uses it, so both moments call this. */
export async function resolveReviewFixture(fixturesRoot: string, task: ReviewFixtureDescriptor): Promise<ReviewFixturePaths> {
  const artifactPath = await realFileUnder(fixturesRoot, join(task.fixtureDir, task.artifact), `${task.id}/${task.artifact}`);
  if (task.source.kind === "commit") return { kind: "commit", artifactPath, commit: task.source.commit };
  return {
    kind: "project",
    artifactPath,
    projectDir: await realDirectoryUnder(fixturesRoot, join(task.fixtureDir, "project"), `${task.id}/project`),
  };
}

/** The number of added and removed lines in a unified diff. Only lines inside
 *  a hunk count, so a removed line that starts with "--" is not read as a
 *  file header. */
function changedDiffLines(patch: string): number {
  let changed = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff --git ")) inHunk = false;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) changed++;
  }
  return changed;
}

function diffStratum(patch: string): ReviewStratum {
  const changed = changedDiffLines(patch);
  return STRATUM_BOUNDS.find(([, bound]) => changed <= bound)?.[0] ?? "S4";
}

export function benchmarkMode(persona: string): BenchmarkMode {
  return persona === "implementer" ? "implement" : persona.startsWith("reviewer-") ? "reviewer" : "research";
}

function parseDefect(value: ReturnType<typeof objectValue>, fixtureId: string): ReviewDefect {
  const files = value.files;
  if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
    throw new Error(`${fixtureId}/manifest.json defect files must be strings`);
  }
  const id = value.id;
  const title = value.title;
  const category = value.category;
  const catchCriteria = value.catch_criteria;
  if (typeof id !== "string") throw new Error(`${fixtureId}/manifest.json requires string defects[].id`);
  if (typeof title !== "string") throw new Error(`${fixtureId}/manifest.json requires string defects[].title`);
  if (typeof category !== "string") throw new Error(`${fixtureId}/manifest.json requires string defects[].category`);
  if (typeof catchCriteria !== "string") throw new Error(`${fixtureId}/manifest.json requires string defects[].catch_criteria`);
  const { finder, accepted } = value;
  if (finder !== undefined && typeof finder !== "string") throw new Error(`${fixtureId}/manifest.json defects[].finder must be a string`);
  if (accepted !== undefined && typeof accepted !== "boolean") throw new Error(`${fixtureId}/manifest.json defects[].accepted must be a boolean`);
  // A drafted label is not ground truth until curation accepts it or removes it.
  if (accepted === false) throw new Error(`${fixtureId}/manifest.json defect ${id} is a drafted label; accept it or remove it before the fixture runs`);
  // Absent fields stay absent, so a hand-authored manifest keeps the identity it had before these fields existed.
  return {
    id, title, category, files, catch_criteria: catchCriteria,
    ...(finder === undefined ? {} : { finder }),
    ...(accepted === undefined ? {} : { accepted }),
  };
}

/** A commit source names one full commit ID of this repository; the reviewed
 *  diff applies to that commit's tree. */
async function readCommitSource(fixturesRoot: string, fixtureDir: string, fixtureId: string): Promise<ReviewSource | undefined> {
  const path = join(fixtureDir, "source.json");
  if (!await isPresent(path)) return undefined;
  const value = objectValue(JSON.parse(await Bun.file(await realFileUnder(fixturesRoot, path, `${fixtureId}/source.json`)).text()), `${fixtureId}/source.json`);
  const unknown = Object.keys(value).find((key) => key !== "commit");
  if (unknown !== undefined) throw new Error(`${fixtureId}/source.json.${unknown} is not a source field`);
  const commit = value.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${fixtureId}/source.json commit must be a full 40-character lowercase commit ID`);
  return { kind: "commit", commit };
}

function parseManifest(value: ReturnType<typeof objectValue>, fixtureId: string): ReviewManifest {
  const defects = value.defects;
  if (!Array.isArray(defects)) throw new Error(`${fixtureId}/manifest.json requires a defects array`);
  const parsedDefects = defects.map((defect) => parseDefect(objectValue(defect, `${fixtureId}/manifest.json defect`), fixtureId));
  if (new Set(parsedDefects.map((defect) => defect.id)).size !== parsedDefects.length) {
    throw new Error(`${fixtureId}/manifest.json defect IDs must be unique`);
  }
  const title = value.title;
  const reviewPromptHint = value.review_prompt_hint;
  if (typeof title !== "string") throw new Error(`${fixtureId}/manifest.json requires string title`);
  if (typeof reviewPromptHint !== "string") throw new Error(`${fixtureId}/manifest.json requires string review_prompt_hint`);
  return { title, defects: parsedDefects, review_prompt_hint: reviewPromptHint };
}

/** The prompt of a fixture that records none in `prompt.md`. */
export function reviewPrompt(artifact: ReviewTask["artifact"], hint: string, source: ReviewSource["kind"] = "project"): string {
  if (artifact === "plan.md") {
    return `Review the implementation plan in plan.md against the project in this directory. ${hint}. Verify every claim the plan makes about the code against the code itself before trusting it. Report every defect you find, citing the plan location and the file:line code evidence; be specific enough that a reader can act.`;
  }
  if (source === "commit") {
    return `Review the uncommitted change in this Git repository; git diff shows it. ${hint}. Report every defect you find with file:line and severity; be specific enough that a reader can act.`;
  }
  return `Review the change in diff.patch against the project in this directory. ${hint}. Report every defect you find with file:line and severity; be specific enough that a reader can act.`;
}

/** Load every review fixture under the root, or none when the root is absent. */
async function loadReviewFixtures(fixturesRoot: string): Promise<ReviewTask[]> {
  let entries;
  try {
    entries = await readdir(fixturesRoot, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const tasks: ReviewTask[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const fixtureDir = await realDirectoryUnder(fixturesRoot, containedPath(fixturesRoot, entry.name), `${entry.name} review fixture`);
    const manifestPath = await realFileUnder(fixturesRoot, join(fixtureDir, "manifest.json"), `${entry.name}/manifest.json`);
    const manifest = parseManifest(objectValue(JSON.parse(await Bun.file(manifestPath).text()), `${entry.name}/manifest.json`), entry.name);
    // A symlinked plan.md is present and rejected, not skipped in favor of
    // diff.patch: a fixture member that points outside the tree is a fault.
    const artifact: ReviewTask["artifact"] = await isPresent(join(fixtureDir, "plan.md")) ? "plan.md" : "diff.patch";
    const source = await readCommitSource(fixturesRoot, fixtureDir, entry.name) ?? { kind: "project" as const };
    if (source.kind === "commit" && artifact === "plan.md") throw new Error(`${entry.name} reviews a plan, so it cannot apply a diff to a commit source`);
    const recordedPrompt = await isPresent(join(fixtureDir, "prompt.md"))
      ? await Bun.file(await realFileUnder(fixturesRoot, join(fixtureDir, "prompt.md"), `${entry.name}/prompt.md`)).text()
      : undefined;
    const descriptor = { id: entry.name, fixtureDir, artifact, source };
    const fixture = await resolveReviewFixture(fixturesRoot, descriptor);
    const artifactBytes = new Uint8Array(await Bun.file(fixture.artifactPath).arrayBuffer());
    tasks.push({
      ...descriptor,
      manifest,
      prompt: recordedPrompt ?? reviewPrompt(artifact, manifest.review_prompt_hint, source.kind),
      stratum: artifact === "plan.md" ? "plan" : diffStratum(new TextDecoder().decode(artifactBytes)),
      contentIdentity: structuredIdentity({
        manifest,
        artifact: { name: artifact, identity: bytesIdentity(artifactBytes) },
        // A project source keeps the serialized form it had before commit
        // sources returned, so the identities of earlier review campaigns do not change.
        source: fixture.kind === "commit" ? source : { kind: "project", contentIdentity: await directoryIdentity(fixture.projectDir) },
        ...(recordedPrompt === undefined ? {} : { prompt: recordedPrompt }),
      }),
    });
  }
  return tasks;
}

function implementPrompt(): string {
  return `Implement all code changes requested by ${PLAN_FILE} at the root of this repository. Read that file first. Treat its statements as claims to verify against the source, and use narrow checks as you work. Do not run hidden acceptance tests. Hand off the completed work and any evidence-based plan corrections.`;
}

/** Every task, fixture and results path one benchmarked project offers. The
 *  catalog is the only holder of that layout: nothing above it recomputes a
 *  benchmark path, and no production module reaches into the bench tree. */
export interface BenchmarkCatalog {
  readonly projectRoot: string;
  readonly reviewFixturesDir: string;
  readonly implementTasksDir: string;
  /** Persona definitions the production registry loads. */
  readonly personaDefinitionsDir: string;
  /** Persona definitions layered over the production ones, present only
   *  when a launch names an overlay directory. */
  readonly personaOverlayDir?: string;
  readonly researchPersonas: readonly string[];
  researchTasks(persona: string): readonly ResearchTask[];
  reviewTasks(): Promise<readonly ReviewTask[]>;
  implementTasks(): Promise<readonly ImplementTask[]>;
  /** The one directory every results directory of this project lives in. The
   *  run store requires each of its results directories to stay beneath it. */
  readonly resultsRoot: string;
  resultsDir(persona: string, stamp: string): string;
  /** Resolve one existing results directory by the id a launch reported (the
   *  directory name). Containment is enforced here, like every other path this
   *  catalog names. */
  resultsDirById(resultId: string): string;
}

export function createBenchmarkCatalog(projectRoot: string, options: {
  readonly personaOverlayDir?: string;
  readonly resultsRoot?: string;
} = {}): BenchmarkCatalog {
  if (!isAbsolute(projectRoot)) throw new Error(`The benchmark catalog requires an absolute project root, got "${projectRoot}"`);
  const reviewFixturesDir = containedPath(projectRoot, "bench", "ab-persona", "fixtures", "reviews");
  const implementTasksDir = containedPath(projectRoot, "bench", "tasks", "implement");
  const resultsRoot = options.resultsRoot ?? containedPath(projectRoot, "bench", "ab-persona", "results");
  return {
    projectRoot,
    reviewFixturesDir,
    implementTasksDir,
    personaDefinitionsDir: containedPath(projectRoot, "src", "workflows", "agents", "personas"),
    ...(options.personaOverlayDir === undefined ? {} : { personaOverlayDir: options.personaOverlayDir }),
    researchPersonas: Object.keys(TASKS_BY_PERSONA),
    researchTasks(persona) {
      const tasks = TASKS_BY_PERSONA[persona];
      if (!tasks) throw new Error(`No task suite for persona "${persona}"; known: ${Object.keys(TASKS_BY_PERSONA).join(", ")}, implementer, reviewer-*`);
      return tasks.map((task) => {
        const source = { ...task, snapshot: RESEARCH_SNAPSHOT };
        return { ...source, contentIdentity: structuredIdentity(source) };
      });
    },
    reviewTasks: () => loadReviewFixtures(reviewFixturesDir),
    async implementTasks() {
      const specs = await loadImplementTasks(implementTasksDir);
      return specs.map((spec) => ({
        ...spec,
        prompt: spec.kind === "native"
          ? spec.instruction + (spec.environment === undefined ? "" : `\n\n## Native environment context\n${spec.environment}`)
          : implementPrompt(),
        timeoutMs: spec.timeoutMs ?? DEFAULT_IMPLEMENTER_TIMEOUT_MS,
      }));
    },
    resultsRoot,
    resultsDir: (persona, stamp) => containedPath(resultsRoot, `${persona}-${stamp}`),
    resultsDirById: (resultId) => containedPath(resultsRoot, resultId),
  };
}
