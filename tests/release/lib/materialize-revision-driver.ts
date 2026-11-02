/** Materializes revision-matched measurement drivers and their hashed manifest in scratch.
 * Run with `bun run tests/release/lib/materialize-revision-driver.ts --source <checkout> --archive <archive> --out <scratch-directory>`.
 * Without `--tag <published-tag>`, the checkout must be pre-D revision 01612ddbd5 with its sampler patch.
 * A tagged checkout supplies the published reconciliation client and fixture serializer.
 * Both modes need installed dependencies; neither changes the source checkout or archive. */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const preDRevision = "01612ddbd517c1dc76eea1797ad1f07f06a5ef99"
const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  source: { type: "string" }, archive: { type: "string" }, out: { type: "string" },
  tag: { type: "string" },
} })
if (!values.source || !values.archive || !values.out) throw new Error("--source, --archive, and --out are required")
const sourceRoot = resolve(values.source)
const candidateRoot = resolve(import.meta.dir, "../../..")
const outputRoot = resolve(values.out)
const tagIdentity = values.tag ? Bun.spawnSync(["git", "rev-parse", `${values.tag}^{commit}`], { cwd: sourceRoot, windowsHide: true, stderr: "inherit" }) : undefined
if (tagIdentity && tagIdentity.exitCode !== 0) throw new Error("published source tag cannot be resolved")
const revision = tagIdentity?.stdout.toString().trim() ?? preDRevision
const identity = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: sourceRoot, windowsHide: true, stderr: "inherit" })
if (identity.exitCode !== 0 || identity.stdout.toString().trim() !== revision) throw new Error(`source checkout must be ${revision}`)

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

if (values.tag) {
  mkdirSync(outputRoot, { recursive: true })
  const scenario = join(candidateRoot, "tests/release/scenarios/chat-runner-reconciliation.ts")
  const isolated = join(candidateRoot, "tests/release/lib/isolated-serve.ts")
  const provider = join(candidateRoot, "tests/release/scenarios/workflow-load-provider.ts")
  const scenarioCopy = join(outputRoot, "published-reconciliation.ts")
  // Both variants measure the same open-to-ready interval; only the tagged client's wire decoder differs.
  let scenarioSource = replace(readFileSync(scenario, "utf8"),
    'import { runRevisionDriver } from "../lib/revision-driver.js"\n', "")
  scenarioSource = replace(scenarioSource, '  if (context.measurementRole === "baseline") return runRevisionDriver(context, "runner-reconciliation", true)\n', "")
  writeFileSync(scenarioCopy, absoluteImports(scenarioSource, join(sourceRoot, "tests/release/scenarios/chat-runner-reconciliation.ts"), {
    "../lib/isolated-serve.js": isolated,
    "./workflow-load-provider.js": provider,
  }))
  const entrypoint = join(outputRoot, "published-driver.ts")
  writeFileSync(entrypoint, [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    `import { runChatRunnerReconciliationScenario } from ${JSON.stringify(scenarioCopy)}`,
    `import { createTimeline } from ${JSON.stringify(join(sourceRoot, "tests/release/lib/timeline.ts"))}`,
    `import { generateFixtureWorkspace } from ${JSON.stringify(join(sourceRoot, "tests/release/fixtures/generate-store.ts"))}`,
    "const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))",
    "if (input.scenario === 'runner-fixture') {",
    "  const metrics = await generateFixtureWorkspace(input.context.workDir)",
    "  writeFileSync(input.output, JSON.stringify({ metrics, failures: [] }))",
    "  process.exit(0)",
    "}",
    "if (input.scenario !== 'runner-reconciliation') throw new Error('unsupported published scenario')",
    "const result = await runChatRunnerReconciliationScenario({ ...input.context, timeline: createTimeline() })",
    "writeFileSync(input.output, JSON.stringify(result))",
  ].join("\n"))
  // The cache outlives either checkout. Bundle both clients and the fixture writer,
  // including package dependencies, rather than retaining imports into their trees.
  const build = await Bun.build({
    entrypoints: [entrypoint], outdir: outputRoot, target: "bun", conditions: ["browser"],
  })
  if (!build.success) throw new AggregateError(build.logs, "published driver bundle failed")
  const bundledEntrypoint = join(outputRoot, "published-driver.js")
  const manifest = join(outputRoot, "published-driver.json")
  writeFileSync(manifest, `${JSON.stringify({
    sourceRevision: revision, sourceRoot: outputRoot, releaseTag: values.tag, entrypoint: bundledEntrypoint,
    driverSha256: hash(bundledEntrypoint), archiveSha256: hash(resolve(values.archive)), archivePath: resolve(values.archive),
    files: build.outputs.filter(output => output.path !== bundledEntrypoint).map(output => ({ path: output.path, sha256: hash(output.path) })),
  }, null, 2)}\n`)
  console.log(`FLYWHEEL_RELEASE_PUBLISHED_DRIVER=${manifest}`)
  process.exit(0)
}

/** Exact replacements fail closed when a retained source no longer has the measured shape. */
function replace(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`revision driver replacement is not unique: ${before}`)
  return source.replace(before, after)
}

function absoluteImports(source: string, original: string, overrides: { readonly [specifier: string]: string } = {}): string {
  return source.replace(/from (["'])(\.\.?\/[^"']+)\1/gu, (_match, _quote: string, specifier: string) =>
    `from ${JSON.stringify(overrides[specifier] ?? resolve(dirname(original), specifier))}`)
}

const isolated = join(candidateRoot, "tests/release/lib/isolated-serve.ts")
const oldParallel = join(sourceRoot, "tests/release/scenarios/parallel-sessions.ts")
let parallel = readFileSync(oldParallel, "utf8")
parallel = replace(parallel, 'JSON.stringify({ source: { kind: "path", path: "parallel-load.workflow.yaml" }',
  'JSON.stringify({ summary: "Inspect parallel load", source: { kind: "path", path: "parallel-load.workflow.yaml" }')
parallel = replace(parallel, '      metrics["parallelChildren.redundantDetailPatches"] = redundantDetailPatches\n', "")
parallel = replace(parallel,
  `      if (redundantDetailPatches !== 0) failures.push(\`\${redundantDetailPatches} detail replacements changed only statistics or repeated equivalent metadata/admission\`)`,
  '      writeFileSync(join(context.evidenceDir, "legacy-churn.json"), JSON.stringify({ redundantDetailPatches, scope: "information only; no paired comparison or gate" }, null, 2))')

// The adapter is measurement tooling. Its client and every runtime dependency still come from the pinned source.
const isolatedSource = readFileSync(isolated, "utf8")
const adapter = absoluteImports(isolatedSource, join(sourceRoot, "tests/release/lib/isolated-serve.ts"))
const parallelSource = absoluteImports(parallel, oldParallel, {
  "../lib/isolated-serve.js": join(outputRoot, "pre-d-isolated-serve.ts"),
})
const template = readFileSync(join(import.meta.dir, "pre-d-driver.ts.template"), "utf8")
const entrypointSource = template.replace(/(["'])@(SOURCE|CANDIDATE)@([^"']+)\1/gu, (_match, _quote: string, root: string, suffix: string) =>
  JSON.stringify((root === "SOURCE" ? sourceRoot : candidateRoot).replaceAll("\\", "/") + suffix))
mkdirSync(outputRoot, { recursive: true })
const generated = [
  ["pre-d-driver.ts", entrypointSource],
  ["pre-d-isolated-serve.ts", adapter],
  ["pre-d-parallel-children.ts", parallelSource],
] as const
for (const [name, content] of generated) writeFileSync(join(outputRoot, name), content)
const entrypoint = join(outputRoot, "pre-d-driver.ts")
const dependencies = [
  ...generated.slice(1).map(([name]) => join(outputRoot, name)),
  isolated, oldParallel, join(import.meta.dir, "pre-d-driver.ts.template"),
  join(candidateRoot, "tests/release/scenarios/parallel-workflow-agents.ts"),
  join(candidateRoot, "tests/release/scenarios/workflow-load-provider.ts"),
]
const manifest = join(outputRoot, "baseline-driver.json")
writeFileSync(manifest, `${JSON.stringify({
  sourceRevision: revision, sourceRoot, entrypoint,
  driverSha256: hash(entrypoint), archiveSha256: hash(resolve(values.archive)), archivePath: resolve(values.archive),
  files: dependencies.map((path) => ({ path, sha256: hash(path) })),
}, null, 2)}\n`)
console.log(`FLYWHEEL_RELEASE_BASELINE_DRIVER=${manifest}`)
