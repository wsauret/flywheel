import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { loadWorkflowFiles } from "../../../helpers/workflow-files.js"
import { loopBody, mapStages, walkFlow, whileMap } from "../../../../src/workflows/retired-step-grammar/schema.js"
import { retiredBuiltInDefinition, retiredBuiltInText } from "../../../../src/workflows/vm/retired-built-in-definitions.js"
import { agentRecords, WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { convertStepGrammar } from "../../../../src/workflows/retired-step-grammar/convert.js"

// The six built-in workflows of the last build before phases. A paused run
// of one of them names the step record keys of its base text in each stored
// node and attempt. Conversion preserves those keys even when the workflow
// and its briefs are no longer installed. Remove after 2027-04-30 with the
// step-grammar conversion.

const revision = repoDefinitions().captureRevision()

/** The sha256 of each file at commit 301e51b8b, from `git show`. */
const BASE_SHA256 = new Map([
  ["debug", "1214b4fa491bcc7b2029a70cfa3e2d7126dff645c0a2c53ef05848a2b86d4065"],
  ["implement", "a6d00c434e594511fa25eb16cb456d8b72231dbe833e543ad842641ddc106a6e"],
  ["qa", "33946a09f810a2dce8caae851bf7225938ef9380d61089001e2bbe1ab6edf297"],
  ["bench-implement", "714ef9c08d8f3aa2ae82af4456d231a8a2b2926d88ccba73f4699330e3dfcbe3"],
  ["bench-plan", "b51b435eed6623b7aac51a3a118c514f213442aaf911fa466e61045a84476e68"],
  ["raindrop-audit", "14647b19e16f683e72f4d600b3bb95b7d573d48f3dbdebd919b299756a9b3e00"],
])
const IDS = [...BASE_SHA256.keys()]

function installedOrConverted(id: string): WorkflowDefinition {
  const base = retiredBuiltInDefinition(id)
  if (!base) throw new Error(`no base text for ${id}`)
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema)(convertStepGrammar(base).document)
}

/** The step record key of each flow entry of the base text, which a stored
 *  node or attempt of a paused run names as its `definitionId`. */
function baseRecordKeys(id: string): readonly string[] {
  const workflow = retiredBuiltInDefinition(id)
  if (!workflow) throw new Error(`no base text for ${id}`)
  const keys = new Set<string>()
  walkFlow(workflow.flow, (entry) => {
    if ("phase" in entry) return
    if ("step" in entry) {
      keys.add(entry.step)
      for (let next = entry.then; next !== undefined; next = next.then) keys.add(next.step)
      return
    }
    const map = "map" in entry ? entry : whileMap(entry)
    if (map !== undefined) for (const step of mapStages(map)) keys.add(step)
    else if (!("map" in entry)) for (const { step } of loopBody(entry)) keys.add(step)
  })
  return [...keys].sort()
}

describe("the built-in workflows of the last build before phases", () => {
  it.each([...BASE_SHA256])("keeps the base bytes of %s", (id, sha256) => {
    expect(createHash("sha256").update(retiredBuiltInText(id) ?? "").digest("hex")).toBe(sha256)
  })

  it.each(IDS)("preserves in %s an agent record for each step record key of its base text", (id) => {
    const keys = baseRecordKeys(id)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((key) => !agentRecords(installedOrConverted(id)).has(key))).toEqual([])
  })

  // The base text names its step files by a path in the folder they had,
  // which the briefs folder replaced, so the launch names each one by its
  // bundled path, which the conversion maps to the brief of the same name.
  // Each text loads from the folder of its built-in, as the base loaded it.
  it.each(IDS)("refuses a new launch of the base text of %s because its briefs retired", (id) => {
    const dir = "/scratch/retired-workflows"
    const content = (retiredBuiltInText(id) ?? "").replaceAll("file: steps/", "file: bundled:steps/")
    const entry = { file: `${dir}/${id}.yaml`, location: { root: { kind: "directory" as const, dir }, path: `${id}.yaml` }, content }
    const { results, errors } = loadWorkflowFiles([entry], "bundled", undefined, undefined, revision.skills)
    expect(results.has(id)).toBe(false)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every(({ message }) => message.includes("which Flywheel no longer ships"))).toBe(true)
  })
})
