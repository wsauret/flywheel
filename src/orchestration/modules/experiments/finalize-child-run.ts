import { Schema } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { OwnedCommandRunner } from "../../../infra/owned-command.js"
import { readManifestPackage, readSkillPackageFiles } from "../../../workflows/skill-context.js"
import type { SkillDefinition } from "../../../workflows/skill-schema.js"
import type { ExternalSkillChildGrant, ExternalSkillChildRunInput, ExternalSkillChildRunResult } from "../../agent-runtime/tools/skill.js"

const FINALIZE_SKILL_ID = "experiment-finalize"
const FINALIZE_SCRIPT = "finalize.sh"

/** A finalization walks Git once per group; large sessions stay well inside this. */
const FINALIZE_TIMEOUT_MS = 10 * 60_000
const REPORTED_OUTPUT_CHARS = 8_000

const FullHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/))
const Text = Schema.String.check(Schema.isMinLength(1))

const FinalizeGroupSchema = Schema.Struct({
  title: Text,
  body: Schema.String,
  last_commit: FullHash,
  slug: Slug,
})

/** The approved grouping, exactly as the finalizer script reads it. */
const FinalizeGroupsSchema = Schema.Struct({
  base: FullHash,
  trunk: Text,
  final_tree: FullHash,
  goal: Slug,
  groups: Schema.Array(FinalizeGroupSchema).check(Schema.isMinLength(1)),
})

export type FinalizeGroups = typeof FinalizeGroupsSchema.Type

const decodeGroups = Schema.decodeUnknownSync(FinalizeGroupsSchema, { onExcessProperty: "error" })

export interface FinalizeChildRunDeps {
  /** Resolves a bundled skill from the revision this request was admitted with. */
  readonly resolveSkill: (id: string) => SkillDefinition | undefined
  /** Session scratch directory; the script and its input are materialized under it. */
  readonly scratchDir: string
  /** The experiment working tree the script runs Git in. */
  readonly workDir: string
  readonly runOwnedCommand: OwnedCommandRunner
}

/** The one bundled child-run grant: `experiment-finalize/finalize.sh` with an
 *  approved groups object. The host reads the package's exact admitted bytes,
 *  proves they still match the package identity the revision published,
 *  materializes the script and the groups into session scratch, and runs the
 *  script through the owned command runner. Any other skill, script, or input
 *  shape is refused before anything is written. A non-zero exit or a timeout is
 *  reported as an error that carries the script's own output. */
export function createFinalizeChildGrant(deps: FinalizeChildRunDeps): ExternalSkillChildGrant {
  const run = async (request: ExternalSkillChildRunInput): Promise<ExternalSkillChildRunResult> => {
    if (request.skillId !== FINALIZE_SKILL_ID) throw new Error(`Child skill "${request.skillId}" is not granted`)
    if (request.script !== FINALIZE_SCRIPT) throw new Error(`Child skill "${FINALIZE_SKILL_ID}" grants only "${FINALIZE_SCRIPT}"`)
    const groups = decodeGroups(request.input)
    const script = admittedScriptBytes(deps.resolveSkill(FINALIZE_SKILL_ID))

    const dir = join(deps.scratchDir, FINALIZE_SKILL_ID)
    mkdirSync(dir, { recursive: true })
    const scriptPath = join(dir, FINALIZE_SCRIPT)
    const groupsPath = join(dir, "groups.json")
    writeFileSync(scriptPath, script, { mode: 0o700 })
    writeFileSync(groupsPath, JSON.stringify(groups, null, 2), { mode: 0o600 })

    const result = await deps.runOwnedCommand(["bash", scriptPath, groupsPath], {
      cwd: deps.workDir,
      timeoutMs: FINALIZE_TIMEOUT_MS,
    })
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(-REPORTED_OUTPUT_CHARS)
    if (result.timedOut) throw new Error(`${FINALIZE_SCRIPT} timed out.\n${output}`)
    if (result.exitCode !== 0) throw new Error(`${FINALIZE_SCRIPT} exited with code ${String(result.exitCode)}.\n${output}`)
    return { skillId: FINALIZE_SKILL_ID, output: { exitCode: 0, stdout: result.stdout, stderr: result.stderr } }
  }
  return { skillIds: Object.freeze([FINALIZE_SKILL_ID]), run }
}

/** Exact script text from the bundled package, identity-verified against the
 *  revision so a package edited after admission cannot execute. */
function admittedScriptBytes(skill: SkillDefinition | undefined): string {
  if (!skill || skill.source.authority !== "bundled") throw new Error(`Bundled skill "${FINALIZE_SKILL_ID}" is not installed`)
  if (!skill.resources.some(({ path }) => path === FINALIZE_SCRIPT)) {
    throw new Error(`Bundled skill "${FINALIZE_SKILL_ID}" does not declare "${FINALIZE_SCRIPT}"`)
  }
  const files = skill.source.kind === "manifest" ? skill.source.files : readSkillPackageFiles(skill.source, "bundled")
  if (!files) throw new Error(`Bundled skill "${FINALIZE_SKILL_ID}" is missing from its package directory`)
  const identity = readManifestPackage(files).identity
  if (identity.sha256 !== skill.packageIdentity.sha256 || identity.bytes !== skill.packageIdentity.bytes) {
    throw new Error(`Bundled skill "${FINALIZE_SKILL_ID}" changed after admission`)
  }
  const script = files.get(FINALIZE_SCRIPT)
  if (script === undefined) throw new Error(`Bundled skill "${FINALIZE_SKILL_ID}" is missing "${FINALIZE_SCRIPT}"`)
  return script
}
