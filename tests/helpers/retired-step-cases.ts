type Keys = { readonly [key: string]: unknown }

const items = (key: string) => ({ type: "list", max: 3, unique: key, description: "Items.", of: { type: "object", fields: { [key]: { type: "string", description: "Key." } } } })
export const step = (id: string, extra: Keys = {}) => ({ name: id, instructions: `Do ${id}.`, ...extra })
export const listed = (id: string, key = "id") => step(id, { output: { summary: `What ${id} found.`, fields: { findings: items(key) } } })
export const SOURCE = { source: step("source", { output: { summary: "The plan.", fields: { items: items("id") } } }) }

/** A step-grammar session file, as JSON, which every YAML reader reads. */
export function stepFile(steps: Keys, flow: readonly Keys[], header: Keys = {}): string {
  return JSON.stringify({ id: "converted", name: "Converted", description: "A converted file.", ...header, steps, flow }, null, 2)
}

export const RETIRED_FLOW_CASES = [
  {
    kind: "step",
    steps: { a: step("a"), b: step("b") },
    flow: [{ step: "a" }, { step: "b" }],
    phases: [{ phase: "a", name: "a", brief: "Do a." }, { phase: "b", name: "b", brief: "Do b." }],
    notes: ["steps and flow became phases"],
  },
  {
    kind: "then with when",
    steps: { a: listed("a"), b: step("b") },
    flow: [{ step: "a", then: { step: "b", when: "findings" } }],
    phases: [{ phase: "a" }, { phase: "b", if: "a.findings" }],
    notes: ["steps and flow became phases", 'then "b" became phase "b" with if: a.findings'],
  },
  {
    kind: "map",
    steps: { ...SOURCE, review: listed("review", "site"), report: step("report", { reads: ["reviews"] }) },
    flow: [{ step: "source" }, { map: "source.items", id: "reviews", label: "id", do: "review", join: { reducer: "dedupe", with: { items: "findings", by: "site" } } }, { step: "report" }],
    phases: [
      { phase: "source" },
      { phase: "review", over: "source.items", label: "id", join: { reducer: "dedupe", with: { items: "findings", by: "site" } }, name: "review" },
      { phase: "report", reads: ["review"] },
    ],
    notes: ["steps and flow became phases"],
  },
  {
    kind: "map with a do chain, a bare collect join, and a stage that reads",
    steps: { scope: step("scope"), ...SOURCE, review: listed("review"), check: step("check", { reads: ["scope"] }), report: step("report", { reads: ["checks"] }) },
    flow: [{ step: "scope" }, { step: "source" }, { map: "source.items", id: "checks", do: ["review", "check"], join: { reducer: "collect" } }, { step: "report" }],
    phases: [
      { phase: "scope" },
      { phase: "source" },
      { phase: "review", over: "source.items" },
      { phase: "check", over: "review", reads: ["scope"] },
      { phase: "report", reads: ["check"] },
    ],
    notes: ["steps and flow became phases", 'map "checks": join: { reducer: collect } was dropped, because collect is the default'],
  },
  {
    kind: "while",
    steps: { a: step("a"), b: listed("b") },
    flow: [{ while: "b.findings", do: ["a", "b"], maxIterations: 3, detectStuck: true }],
    phases: [{ repeat: { while: "b.findings", max: 3, stuck: true }, phases: [{ phase: "a" }, { phase: "b" }] }],
    notes: ["steps and flow became phases"],
  },
  {
    kind: "while over a map",
    steps: { ...SOURCE, hunt: listed("hunt", "site") },
    flow: [{ step: "source" }, { while: "finds.kept", maxIterations: 2, do: { map: "source.items", id: "finds", do: "hunt", join: { reducer: "dedupe", with: { items: "findings", by: "site" } } } }],
    phases: [{ phase: "source" }, { repeat: { while: "hunt.kept", max: 2 }, phases: [{ phase: "hunt", over: "source.items", name: "hunt" }] }],
    notes: ["steps and flow became phases"],
  },
  {
    kind: "for with reassess",
    steps: { ...SOURCE, work: step("work"), reassess: step("reassess") },
    flow: [{ step: "source" }, { for: "source.items", do: "work", reassess: "reassess" }],
    phases: [{ phase: "source" }, { repeat: { each: "source.items", reassess: "reassess" }, phases: [{ phase: "work" }, { phase: "reassess" }] }],
    notes: ["steps and flow became phases"],
  },
  {
    kind: "phase container with limits",
    steps: { a: step("a"), b: step("b"), c: step("c") },
    flow: [{ phase: "build", limits: { nodes: 4, depth: 2 }, flow: [{ step: "a" }, { step: "b" }] }, { step: "c" }],
    phases: [{ phase: "a" }, { phase: "b" }, { phase: "c" }],
    notes: ["steps and flow became phases", 'the limits of phase "build" were dropped'],
  },
]
