import { describe, expect, it } from "bun:test"
import { latestReducer, requireReducer, runReducer } from "../../../../src/workflows/reducers/registry.js"
import type { EarlierRound, JoinContracts, ReducerInputSlot } from "../../../../src/workflows/reducers/reducer.js"
import { compiledFields } from "../../../../src/workflows/output-contract/compile.js"
import type { Field, FieldMap } from "../../../../src/workflows/output-contract/grammar.js"
import { workflowReducerLines } from "../../../../src/orchestration/modules/workflows/cli/reducers.js"

const coverage = latestReducer("coverage")!
const PARAMS = { priority: "priority", outcome: "outcome", exclusions: "exclusions" }
const WIDTH = 8

/** The contracts around a join that reads none of them. */
const NO_CONTRACTS: JoinContracts = { key: "id", item: { name: "items", fields: [] }, joined: { name: "output", fields: [] }, source: null }

/** One manifest slot: a completed branch reports `outcome`, and `failed`
 *  has no handoff. */
function slot(ordinal: number, key: string, priority: string, outcome: string | "failed"): ReducerInputSlot {
  const failed = outcome === "failed"
  return {
    ordinal,
    key,
    branchNodeId: `group:branch:${ordinal}`,
    disposition: failed ? "failed" : "completed",
    handoff: failed ? null : { stepId: `group:branch:${ordinal}:stage:2:attempt:1`, sha256: `sha-${key}` },
    content: failed ? null : { summary: `verdict on ${key}`, outcome },
    item: { id: key, priority },
  }
}

const fold = (slots: readonly ReducerInputSlot[], exclusions: readonly unknown[] = []) =>
  runReducer(coverage, PARAMS, { slots, key: "id", source: { summary: "The inventory.", exclusions }, contract: coverage.output(PARAMS, NO_CONTRACTS, WIDTH), earlierRounds: [] })

describe("coverage@1", () => {
  // Manifest order is not key order, so every list proves its own sort.
  const survey = [
    slot(1, "e", "required", "surveyed"),
    slot(2, "a", "required", "failed"),
    slot(3, "d", "supporting", "inaccessible"),
    slot(4, "c", "required", "inaccessible"),
    slot(5, "b", "supporting", "surveyed"),
    slot(6, "f", "required", "excluded"),
  ]

  it("splits required and supporting coverage with exact counts and complements in key order", () => {
    const output = fold(survey, [{ id: "z" }, { id: "x" }])
    expect(output).toMatchObject({
      status: "partial",
      required: { numerator: 1, denominator: 4, surveyed: ["e"], unsurveyed: ["a", "c", "f"] },
      supporting: { numerator: 1, denominator: 2, surveyed: ["b"], unsurveyed: ["d"] },
      inaccessible: ["c", "d"],
      excluded: ["f", "x", "z"],
      failed: ["a"],
    })
    // Each branch keeps a reference to its report, never a copy of it.
    expect(output["items"]).toEqual([
      { key: "a", priority: "required", disposition: "failed", outcome: null, handoff: null },
      { key: "b", priority: "supporting", disposition: "completed", outcome: "surveyed", handoff: { step_id: "group:branch:5:stage:2:attempt:1", sha256: "sha-b" } },
      { key: "c", priority: "required", disposition: "completed", outcome: "inaccessible", handoff: { step_id: "group:branch:4:stage:2:attempt:1", sha256: "sha-c" } },
      { key: "d", priority: "supporting", disposition: "completed", outcome: "inaccessible", handoff: { step_id: "group:branch:3:stage:2:attempt:1", sha256: "sha-d" } },
      { key: "e", priority: "required", disposition: "completed", outcome: "surveyed", handoff: { step_id: "group:branch:1:stage:2:attempt:1", sha256: "sha-e" } },
      { key: "f", priority: "required", disposition: "completed", outcome: "excluded", handoff: { step_id: "group:branch:6:stage:2:attempt:1", sha256: "sha-f" } },
    ])
    expect(JSON.stringify(output)).not.toContain("verdict on")
    // The coverage that the tree carries is a projection of this output.
    expect(coverage.coverage?.(output)).toEqual({ status: "partial", required: { surveyed: 1, total: 4 }, unsurveyed: ["a", "c", "f"] })
  })

  it("never counts a branch that failed or stated no outcome as surveyed", () => {
    const unread: ReducerInputSlot = { ...slot(1, "a", "required", "surveyed"), content: { summary: "no outcome" } }
    expect(fold([unread, slot(2, "b", "required", "failed")])).toMatchObject({
      status: "partial",
      required: { numerator: 0, denominator: 2, surveyed: [], unsurveyed: ["a", "b"] },
      failed: ["a", "b"],
    })
  })

  it("is full only when every required target was surveyed, whatever the supporting targets did", () => {
    const output = fold([slot(1, "a", "required", "surveyed"), slot(2, "b", "supporting", "failed")])
    expect(output).toMatchObject({ status: "full", required: { numerator: 1, denominator: 1, unsurveyed: [] }, supporting: { numerator: 0, denominator: 1, unsurveyed: ["b"] } })
  })

  it("never reads full when the manifest holds no required target", () => {
    const output = fold([slot(1, "a", "supporting", "failed"), slot(2, "b", "supporting", "surveyed")])
    expect(output).toMatchObject({ status: "partial", required: { numerator: 0, denominator: 0, unsurveyed: [] }, supporting: { numerator: 1, denominator: 2, unsurveyed: ["a"] }, failed: ["a"] })
    expect(coverage.coverage?.(output)).toEqual({ status: "partial", required: { surveyed: 0, total: 0 }, unsurveyed: [] })
  })

  it("reads an empty manifest as empty, with zero counts and no ratio, and keeps the source's exclusions", () => {
    const output = fold([], ["y"])
    expect(output).toEqual({
      status: "empty",
      required: { numerator: 0, denominator: 0, surveyed: [], unsurveyed: [] },
      supporting: { numerator: 0, denominator: 0, surveyed: [], unsurveyed: [] },
      inaccessible: [],
      excluded: ["y"],
      failed: [],
      items: [],
    })
    expect(coverage.coverage?.(output)).toEqual({ status: "empty", required: { surveyed: 0, total: 0 }, unsurveyed: [] })
  })

  it("folds the same output for the same input in any settlement order, every time", () => {
    const first = fold(survey, ["x"])
    expect(fold(survey, ["x"])).toEqual(first)
    expect(fold(survey.toReversed(), ["x"])).toEqual(first)
  })

  it("admits exclusions that name no target once each, and refuses a repeat or a target", () => {
    const admit = (exclusions: readonly unknown[]) => coverage.admit(PARAMS, { exclusions }, ["a", "b"], "id")
    expect(admit([{ id: "x" }, "y"])).toBeUndefined()
    expect(coverage.admit(PARAMS, { summary: "No exclusions list." }, ["a"], "id")).toBeUndefined()
    expect(admit(["x", { id: "x" }])).toBe('exclusions repeat the key "x"')
    expect(admit([{ id: "b" }])).toBe('exclusion "b" is also a target')
    expect(admit([{ name: "x" }])).toBe('exclusion 1 has no string "id"')
  })

  it.each([
    { type: "string" },
    { type: "object", fields: { id: { type: "string", description: "The target key." } } },
  ] satisfies Field[])("refuses nullable $type exclusion items before expansion", (item) => {
    const contracts = (of: Field): JoinContracts => ({
      key: "id",
      item: { name: "targets", fields: compiledFields({ priority: { type: "enum", description: "The priority.", values: ["required", "supporting"] } }) },
      joined: { name: "report", fields: compiledFields({ outcome: { type: "enum", description: "The outcome.", values: ["surveyed", "inaccessible", "excluded"] } }) },
      source: { name: "inventory", fields: compiledFields({ exclusions: { type: "list", description: "Excluded targets.", of } }) },
    })
    expect(coverage.check(PARAMS, contracts({ ...item, nullable: true }))).toBe('exclusions "exclusions" must hold non-null items; remove nullable from the list item contract of the inventory')
    expect(coverage.check(PARAMS, contracts(item))).toBeUndefined()
  })
})

/** The fields of one finding that a review stage lists. */
const FINDING = {
  id: { type: "string", description: "The finding id." },
  severity: { type: "enum", values: ["low", "medium", "high"], description: "How severe the finding is." },
  score: { type: "number", optional: true, description: "How much the finding matters." },
} as const

/** The contracts around a join over a map of files whose last stage lists
 *  findings, at most 3 per file, keyed by `id`. */
function reviewContracts(joined: FieldMap = { findings: { type: "list", description: "The findings.", max: 3, unique: "id", of: { type: "object", fields: FINDING } } }): JoinContracts {
  return {
    key: "file",
    item: { name: 'items of "input.files"', fields: compiledFields({ file: { type: "string", description: "The file." }, area: { type: "string", description: "The area." } }) },
    joined: { name: 'output of the last stage "review"', fields: compiledFields(joined) },
    source: null,
  }
}

/** One branch of the review map over `file`: a completed branch lists
 *  `content`, and `failed` has no handoff. */
function reviewSlot(ordinal: number, file: string, content: { readonly [key: string]: unknown } | "failed", area = "core"): ReducerInputSlot {
  const failed = content === "failed"
  return {
    ordinal,
    key: file,
    branchNodeId: `group:branch:${ordinal}`,
    disposition: failed ? "failed" : "completed",
    handoff: failed ? null : { stepId: `group:branch:${ordinal}:stage:1:attempt:1`, sha256: `sha-${file}` },
    content: failed ? null : { summary: `review of ${file}`, ...content },
    item: { file, area },
  }
}

const finding = (id: string, severity: "low" | "medium" | "high", score?: number) => ({ id, severity, ...(score === undefined ? {} : { score }) })

/** Fold one reducer over `slots` against the output contract that
 *  compilation pins for these contracts and a width of 4. `version` picks a
 *  registered version other than the latest, and `earlierRounds` are the
 *  outputs of the earlier rounds of the loop that owns the join. */
function foldWithVersion(id: string, params: { readonly [key: string]: unknown }, slots: readonly ReducerInputSlot[], contracts = reviewContracts(), { version, earlierRounds = [] }: { readonly version?: number; readonly earlierRounds?: readonly EarlierRound[] } = {}) {
  const reducer = version === undefined ? latestReducer(id)! : requireReducer(id, version)
  const decoded = reducer.decodeParams(params)
  expect(reducer.check(decoded, contracts)).toBeUndefined()
  const contract = reducer.output(decoded, contracts, 4)
  const output = runReducer(reducer, decoded, { slots, key: "file", source: null, contract, earlierRounds })
  return { output, contract, selection: reducer.selection?.(output, contract) }
}

const foldWith = (id: string, params: { readonly [key: string]: unknown }, slots: readonly ReducerInputSlot[], contracts = reviewContracts()) => foldWithVersion(id, params, slots, contracts)

const DEDUPE = { items: "findings", by: "id" }

describe("dedupe@1", () => {
  const foldFirst = (slots: readonly ReducerInputSlot[]) => foldWithVersion("dedupe", DEDUPE, slots, reviewContracts(), { version: 1 })
  // Manifest order is not key order, and a branch with no list, which an
  // optional field allows, reports no entries.
  const reviews = [
    reviewSlot(1, "b.ts", { findings: [finding("F2", "low"), finding("F1", "high")] }),
    reviewSlot(2, "a.ts", { findings: [finding("F1", "low"), finding("F3", "medium"), finding("F1", "high")] }),
    reviewSlot(3, "c.ts", "failed"),
    reviewSlot(4, "d.ts", {}),
  ]

  it("keeps the first item per key in branch-key and list order, and drops each duplicate with the branch it repeats", () => {
    const { output, selection } = foldFirst(reviews)
    expect(output).toEqual({
      kept: [
        { ...finding("F1", "low"), branch: "a.ts" },
        { ...finding("F3", "medium"), branch: "a.ts" },
        { ...finding("F2", "low"), branch: "b.ts" },
      ],
      dropped: [
        { key: "F1", branch: "a.ts", reason: "duplicate of a.ts" },
        { key: "F1", branch: "b.ts", reason: "duplicate of a.ts" },
      ],
      failed: ["c.ts"],
    })
    expect(selection).toEqual({
      verb: "kept",
      kept: [{ key: "F1", branch: "a.ts" }, { key: "F3", branch: "a.ts" }, { key: "F2", branch: "b.ts" }],
      dropped: [{ key: "F1", branch: "a.ts", reason: "duplicate of a.ts" }, { key: "F1", branch: "b.ts", reason: "duplicate of a.ts" }],
      failed: ["c.ts"],
    })
    expect(foldFirst(reviews.toReversed()).output).toEqual(output)
  })

  it("drops an item that states no key instead of keeping it under no key", () => {
    const { output } = foldFirst([reviewSlot(1, "a.ts", { findings: [{ severity: "low" }, finding("F1", "low")] })])
    expect(output).toMatchObject({ kept: [{ id: "F1", branch: "a.ts" }], dropped: [{ key: null, branch: "a.ts", reason: 'has no "id"' }] })
  })

  it("declares a kept list of the item fields and the branch, unique on the key, at the worst case of width times the list max", () => {
    const { contract } = foldFirst([])
    expect(contract["kept"]).toMatchObject({ type: "list", max: 12, unique: "id", of: { type: "object", fields: { ...FINDING, branch: { type: "string" } } } })
    expect(contract["dropped"]).toMatchObject({ type: "list", max: 12 })
    expect(contract["failed"]).toMatchObject({ type: "list", max: 4 })
  })
})

describe("dedupe@2", () => {
  const reviews = [
    reviewSlot(1, "b.ts", { findings: [finding("F2", "low"), finding("F1", "high")] }),
    reviewSlot(2, "a.ts", { findings: [finding("F1", "low"), finding("F3", "medium"), finding("F1", "high")] }),
    reviewSlot(3, "c.ts", "failed"),
    reviewSlot(4, "d.ts", {}),
  ]
  const foldRound = (slots: readonly ReducerInputSlot[], earlierRounds: readonly EarlierRound[] = []) => foldWithVersion("dedupe", DEDUPE, slots, reviewContracts(), { earlierRounds })

  it("is the latest dedupe and folds as dedupe@1 when no earlier round exists", () => {
    expect(latestReducer("dedupe")?.version).toBe(2)
    const latest = foldRound(reviews)
    const first = foldWithVersion("dedupe", DEDUPE, reviews, reviewContracts(), { version: 1 })
    expect(latest.output).toEqual(first.output)
    expect(latest.selection).toEqual(first.selection)
    // Only the words of the kept list differ: they name the earlier rounds.
    expect({ ...latest.contract["kept"], description: "" }).toEqual({ ...first.contract["kept"], description: "" })
    expect(foldRound([reviewSlot(1, "a.ts", { findings: [{ severity: "low" }] })]).output).toEqual(foldWithVersion("dedupe", DEDUPE, [reviewSlot(1, "a.ts", { findings: [{ severity: "low" }] })], reviewContracts(), { version: 1 }).output)
  })

  it("drops a repeat of an item that round 1 kept or dropped, and a round 2 key in round 3, each with the round that first saw it", () => {
    const round1 = foldRound(reviews).output
    expect(round1["dropped"]).toEqual([{ key: "F1", branch: "a.ts", reason: "duplicate of a.ts" }, { key: "F1", branch: "b.ts", reason: "duplicate of a.ts" }])
    const second = [
      reviewSlot(1, "a.ts", { findings: [finding("F2", "low"), finding("F4", "high")] }),
      reviewSlot(2, "b.ts", { findings: [finding("F1", "high"), finding("F4", "low")] }),
    ]
    const round2 = foldRound(second, [{ round: 1, output: round1 }]).output
    expect(round2).toEqual({
      kept: [{ ...finding("F4", "high"), branch: "a.ts" }],
      dropped: [
        { key: "F2", branch: "a.ts", reason: "seen in round 1" },
        { key: "F1", branch: "b.ts", reason: "seen in round 1" },
        { key: "F4", branch: "b.ts", reason: "duplicate of a.ts" },
      ],
      failed: [],
    })
    const round3 = foldRound([reviewSlot(1, "a.ts", { findings: [finding("F4", "low"), finding("F3", "low")] })], [{ round: 1, output: round1 }, { round: 2, output: round2 }]).output
    expect(round3).toEqual({
      kept: [],
      dropped: [{ key: "F4", branch: "a.ts", reason: "seen in round 2" }, { key: "F3", branch: "a.ts", reason: "seen in round 1" }],
      failed: [],
    })
  })

  it("keeps a null key out of the seen set, so an item without a key reads as one, never as seen", () => {
    const round1 = foldRound([reviewSlot(1, "a.ts", { findings: [{ severity: "low" }] })]).output
    expect(round1["dropped"]).toEqual([{ key: null, branch: "a.ts", reason: 'has no "id"' }])
    const round2 = foldRound([reviewSlot(1, "a.ts", { findings: [{ severity: "high" }, finding("F1", "low")] })], [{ round: 1, output: round1 }]).output
    expect(round2).toMatchObject({ kept: [{ id: "F1" }], dropped: [{ key: null, branch: "a.ts", reason: 'has no "id"' }] })
  })
})

describe("top@1", () => {
  const reviews = [
    reviewSlot(1, "b.ts", { findings: [finding("F3", "high", 5), finding("F1", "high", 3)] }),
    reviewSlot(2, "a.ts", { findings: [finding("F1", "high", 3), finding("F2", "low", 9)] }),
    reviewSlot(3, "c.ts", "failed"),
  ]

  it("ranks an enum by its declaration order, breaks ties on the item key and then the branch key, and keeps each item key once", () => {
    const { output, selection } = foldWith("top", { items: "findings", by: "severity", count: 2, order: "desc" }, reviews)
    expect(output).toEqual({
      kept: [{ ...finding("F1", "high", 3), branch: "a.ts" }, { ...finding("F3", "high", 5), branch: "b.ts" }],
      dropped: [
        { key: "F1", branch: "b.ts", reason: "duplicate of a.ts" },
        { key: "F2", branch: "a.ts", reason: "below the top 2" },
      ],
      failed: ["c.ts"],
    })
    expect(selection).toMatchObject({ verb: "kept", kept: [{ key: "F1" }, { key: "F3" }], failed: ["c.ts"] })
    expect(foldWith("top", { items: "findings", by: "severity", count: 2, order: "desc" }, reviews.toReversed()).output).toEqual(output)
  })

  it("ranks a number in ascending order and drops an item that states no rank after the ranked ones", () => {
    const unranked = reviewSlot(4, "d.ts", { findings: [finding("F9", "low")] })
    const { output } = foldWith("top", { items: "findings", by: "score", count: 1, order: "asc" }, [...reviews, unranked], reviewContracts({
      findings: { type: "list", description: "The findings.", max: 3, unique: "id", of: { type: "object", fields: { ...FINDING, score: { type: "number", description: "How much the finding matters." } } } },
    }))
    expect(output["kept"]).toEqual([{ ...finding("F1", "high", 3), branch: "a.ts" }])
    expect(output["dropped"]).toEqual([
      { key: "F1", branch: "b.ts", reason: "duplicate of a.ts" },
      { key: "F3", branch: "b.ts", reason: "below the top 1" },
      { key: "F2", branch: "a.ts", reason: "below the top 1" },
      { key: "F9", branch: "d.ts", reason: 'has no "score"' },
    ])
  })

  it("ranks an enum of numbers by its declaration order, not by the numeric value", () => {
    const { output } = foldWith("top", { items: "findings", by: "tier", count: 2, order: "desc" }, [
      reviewSlot(1, "a.ts", { findings: [{ id: "F1", tier: 1 }, { id: "F2", tier: 10 }, { id: "F3", tier: 3 }] }),
    ], reviewContracts({
      findings: { type: "list", description: "The findings.", max: 3, unique: "id", of: { type: "object", fields: { id: FINDING.id, tier: { type: "enum", values: [10, 1, 3], description: "The tier." } } } },
    }))
    expect(output).toEqual({
      kept: [{ id: "F3", tier: 3, branch: "a.ts" }, { id: "F1", tier: 1, branch: "a.ts" }],
      dropped: [{ key: "F2", branch: "a.ts", reason: "below the top 2" }],
      failed: [],
    })
  })

  it("declares a kept list of at most count items, unique on the item key", () => {
    expect(foldWith("top", { items: "findings", by: "severity", count: 5, order: "desc" }, []).contract["kept"]).toMatchObject({ max: 5, unique: "id" })
    expect(foldWith("top", { items: "findings", by: "severity", count: 50, order: "desc" }, []).contract["kept"]).toMatchObject({ max: 12 })
  })

  it("ranks the items of a list without a unique key as distinct items, breaks a tie on the branch key and then list order, and keys no kept entry", () => {
    const unkeyed = reviewContracts({ findings: { type: "list", description: "The findings.", max: 3, of: { type: "object", fields: FINDING } } })
    const { output, contract, selection } = foldWith("top", { items: "findings", by: "severity", count: 3, order: "desc" }, reviews, unkeyed)
    expect(output).toEqual({
      kept: [{ ...finding("F1", "high", 3), branch: "a.ts" }, { ...finding("F3", "high", 5), branch: "b.ts" }, { ...finding("F1", "high", 3), branch: "b.ts" }],
      dropped: [{ key: null, branch: "a.ts", reason: "below the top 3" }],
      failed: ["c.ts"],
    })
    expect(contract["kept"]?.unique).toBeUndefined()
    expect(selection).toMatchObject({ kept: [{ key: null, branch: "a.ts" }, { key: null, branch: "b.ts" }, { key: null, branch: "b.ts" }] })
    expect(foldWith("top", { items: "findings", by: "severity", count: 3, order: "desc" }, reviews.toReversed(), unkeyed).output).toEqual(output)
  })
})

describe("quorum@1", () => {
  const VOTE = { verdict: { type: "enum", values: ["valid", "refuted", "abstain"], description: "The verdict." } } as const
  const verify = (ordinal: number, file: string, verdict: string | "failed", area = "core") =>
    reviewSlot(ordinal, file, verdict === "failed" ? "failed" : { verdict }, area)
  const quorum = (params: { readonly [key: string]: unknown }, slots: readonly ReducerInputSlot[]) =>
    foldWith("quorum", { vote: "verdict", ...params }, slots, reviewContracts(VOTE))

  it("passes one verdict when the valid votes reach the floor and the refuted votes stay under the ceiling, and a failed branch abstains", () => {
    const slots = [verify(1, "a.ts", "valid"), verify(2, "b.ts", "refuted"), verify(3, "c.ts", "valid"), verify(4, "d.ts", "failed")]
    const { output, selection } = quorum({ min_valid: 2, max_refuted: 1 }, slots)
    expect(output).toEqual({
      passed: [{ valid: 2, refuted: 1, abstain: 1, reason: "2 valid, at least 2; 1 refuted, at most 1" }],
      rejected: [],
      failed: ["d.ts"],
    })
    expect(selection).toEqual({ verb: "passed", kept: [{ key: "all votes", reason: "2 valid, at least 2; 1 refuted, at most 1" }], dropped: [], failed: ["d.ts"] })
    expect(quorum({ min_valid: 2, max_refuted: 0 }, slots).output["rejected"]).toEqual([{ valid: 2, refuted: 1, abstain: 1, reason: "1 refuted, more than 0" }])
  })

  it("never passes when every branch abstained, failed, or stated no vote, or when the manifest is empty", () => {
    const silent = { ...verify(2, "b.ts", "valid"), content: { summary: "no vote" } }
    expect(quorum({ min_valid: 1, max_refuted: 0 }, [verify(1, "a.ts", "abstain"), silent, verify(3, "c.ts", "failed")]).output).toEqual({
      passed: [],
      rejected: [{ valid: 0, refuted: 0, abstain: 3, reason: "0 valid, fewer than 1" }],
      failed: ["c.ts"],
    })
    expect(quorum({ min_valid: 1, max_refuted: 0 }, []).output).toEqual({ passed: [], rejected: [{ valid: 0, refuted: 0, abstain: 0, reason: "0 valid, fewer than 1" }], failed: [] })
  })

  it("gives each group_by value its own verdict, ordered by that value, whatever the settlement order", () => {
    const slots = [
      verify(1, "a.ts", "valid", "ui"),
      verify(2, "b.ts", "refuted", "core"),
      verify(3, "c.ts", "valid", "core"),
      verify(4, "d.ts", "valid", "ui"),
    ]
    const { output, contract, selection } = quorum({ min_valid: 2, max_refuted: 0, group_by: "area" }, slots)
    expect(output).toEqual({
      passed: [{ group: "ui", valid: 2, refuted: 0, abstain: 0, reason: "2 valid, at least 2; 0 refuted, at most 0" }],
      rejected: [{ group: "core", valid: 1, refuted: 1, abstain: 0, reason: "1 valid, fewer than 2; 1 refuted, more than 0" }],
      failed: [],
    })
    expect(selection).toMatchObject({ verb: "passed", kept: [{ key: "ui" }], dropped: [{ key: "core" }] })
    expect(contract["passed"]).toMatchObject({ max: 4, unique: "group" })
    expect(quorum({ min_valid: 2, max_refuted: 0, group_by: "area" }, slots.toReversed()).output).toEqual(output)
  })

  describe("over a map with votes", () => {
    const VOTES = 3
    const contracts: JoinContracts = { ...reviewContracts(VOTE), votes: VOTES }
    /** One lane of a map with votes: vote `number` on the item `file`, at
     *  lane position `ordinal`. */
    const ballot = (ordinal: number, file: string, number: number, verdict: string | "failed"): ReducerInputSlot => ({
      ...verify(ordinal, file, verdict),
      key: `${file}#${number}`,
      vote: { number, itemKey: file, itemLabel: `File ${file}` },
    })
    const foldVotes = (params: { readonly [key: string]: unknown }, slots: readonly ReducerInputSlot[]) => {
      const reducer = latestReducer("quorum")!
      const decoded = reducer.decodeParams({ vote: "verdict", ...params })
      expect(reducer.check(decoded, contracts)).toBeUndefined()
      const contract = reducer.output(decoded, contracts, 2)
      const output = runReducer(reducer, decoded, { slots, key: "file", source: null, contract, earlierRounds: [], votes: VOTES })
      return { output, contract, selection: reducer.selection?.(output, contract) }
    }

    it("gives each item one verdict over its own votes that names the item, and a failed lane abstains", () => {
      // Lane order is item-major, and b.ts comes first, so the verdicts
      // prove that they order by item key.
      const slots = [
        ballot(1, "b.ts", 1, "valid"), ballot(2, "b.ts", 2, "failed"), ballot(3, "b.ts", 3, "valid"),
        ballot(4, "a.ts", 1, "refuted"), ballot(5, "a.ts", 2, "refuted"), ballot(6, "a.ts", 3, "valid"),
      ]
      const { output, contract, selection } = foldVotes({ min_valid: 2, max_refuted: 1 }, slots)
      expect(output).toEqual({
        passed: [{ key: "b.ts", label: "File b.ts", valid: 2, refuted: 0, abstain: 1, reason: "2 valid, at least 2; 0 refuted, at most 1" }],
        rejected: [{ key: "a.ts", label: "File a.ts", valid: 1, refuted: 2, abstain: 0, reason: "1 valid, fewer than 2; 2 refuted, more than 1" }],
        failed: ["b.ts#2"],
      })
      expect(selection).toMatchObject({ verb: "passed", kept: [{ key: "b.ts" }], dropped: [{ key: "a.ts" }], failed: ["b.ts#2"] })
      // A verdict list holds one verdict per item, so a later map can fan
      // out over it by the item key; the failed list counts every lane.
      expect(contract["passed"]).toMatchObject({ max: 2, unique: "key" })
      expect(contract["failed"]).toMatchObject({ max: 2 * VOTES })
      expect(foldVotes({ min_valid: 2, max_refuted: 1 }, slots.toReversed()).output).toEqual(output)
    })

    it("gives no verdict to an empty manifest", () => {
      expect(foldVotes({ min_valid: 1, max_refuted: 0 }, []).output).toEqual({ passed: [], rejected: [], failed: [] })
    })

    it("refuses group_by and a floor above the votes of each item", () => {
      const reducer = latestReducer("quorum")!
      const check = (params: { readonly [key: string]: unknown }) => reducer.check(reducer.decodeParams({ vote: "verdict", ...params }), contracts)
      expect(check({ min_valid: 2, max_refuted: 1, group_by: "area" })).toMatch(/group_by "area" cannot join a phase with votes.*remove group_by/)
      expect(check({ min_valid: 4, max_refuted: 0 })).toMatch(/min_valid 4 is more than the 3 votes of each item, so no verdict could pass; lower min_valid or raise votes/)
      expect(check({ min_valid: 3, max_refuted: 0 })).toBeUndefined()
    })
  })
})

describe("flywheel workflow reducers", () => {
  it("lists each reducer with the parameters that its join takes", () => {
    expect(workflowReducerLines()).toEqual([
      "collect@1: no parameters",
      "coverage@1:",
      "  priority: The item field whose values are required | supporting.",
      "  outcome: The field of each agent's output that reports surveyed | inaccessible | excluded.",
      "  exclusions (optional): A list field of the source output that names the targets the scope excluded.",
      "dedupe@1:",
      "  items: A list field of each agent's output whose items the join deduplicates.",
      "  by: The required string field of each item that is its key. The first item per key in the key order of the agents that reported them, then list order, is kept.",
      "dedupe@2:",
      "  items: A list field of each agent's output whose items the join deduplicates.",
      "  by: The required string field of each item that is its key. The first item per key in the key order of the agents that reported them, then list order, is kept.",
      "top@1:",
      "  items: A list field of each agent's output whose items the join ranks. With a unique item key, the join keeps each key once.",
      "  by: The required number or enum field of each item that ranks it. An enum ranks by its declaration order, first lowest.",
      "  count: The most items the join keeps.",
      "  order: desc keeps the highest ranks, asc keeps the lowest. Ties break on the item key, then the key of the agent that reported the item.",
      "quorum@1:",
      "  vote: The enum field of each agent's output whose values are exactly valid | refuted | abstain. A failed or unsettled agent abstains.",
      "  min_valid: The fewest valid votes that pass a verdict; at least 1, so an all-abstain vote never passes.",
      "  max_refuted: The most refuted votes that a passing verdict allows.",
      "  group_by (optional): A required string field of each item. Each of its values gets its own verdict. A phase with votes takes none, because each item gets its own verdict.",
    ])
  })
})
