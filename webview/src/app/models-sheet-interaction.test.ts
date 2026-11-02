import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("models-sheet-interaction-fixture.ts", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "models-sheet-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]focus-trap\.ts$/ }, () => ({ contents: "export function trapFocus() {}", loader: "js" }))
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelModelsSheetTestClient') }",
        loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (!javascript) throw new Error("Models sheet fixture build produced no JavaScript")
const { mountModelsSheet }: typeof import("./models-sheet-interaction-fixture.js") =
  await importBuiltModule(javascript)

test("equivalent app frames keep the rendered model table without reloading", async () => {
  const mounted = mountModelsSheet()
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Chat/)
    assert.match(mounted.text(), /gpt-5/)
    const initialQueries = mounted.queryCount()

    await mounted.publishEquivalentFrame()

    assert.equal(mounted.queryCount(), initialQueries)
    assert.match(mounted.text(), /Chat/)
    assert.doesNotMatch(mounted.text(), /Reading/)

    await mounted.selectSession("session-b")
    assert.equal(mounted.queryCount(), initialQueries + 2)
  } finally {
    mounted.dispose()
  }
})

test("model navigation and late responses stay with the scope that opened them", async () => {
  const mounted = mountModelsSheet()
  try {
    await mounted.ready()
    mounted.click("Chat")
    await mounted.selectSession("session-b")
    await mounted.selectSession("session-a")
    mounted.resolveOptions("stale-model")
    await mounted.ready()

    assert.doesNotMatch(mounted.text(), /stale-model/)
    assert.match(mounted.text(), /Scope: this session/)

    mounted.click("Chat")
    mounted.resolveOptions("stale-effort-model")
    await mounted.ready()
    mounted.click("stale-effort-model")
    await mounted.selectSession("session-b")
    await mounted.selectSession("session-a")
    mounted.resolveEfforts(2)
    await mounted.ready()
    assert.equal(mounted.mutations().length, 0)
    assert.match(mounted.text(), /Scope: this session/)

    mounted.click("Chat")
    mounted.resolveOptions("fresh-model")
    await mounted.ready()
    mounted.click("fresh-model")
    mounted.resolveEfforts(1)
    await mounted.ready()
    assert.deepEqual(mounted.mutations().at(-1)?.scope, { kind: "session", sessionId: "session-a" })
  } finally {
    mounted.dispose()
  }
})

test("both model sheets name providers up to the one that serves now and patch the detail in place on refresh", async () => {
  const chain = (serving: string | undefined) => [["ChatGPT Subscription", "ChatGPT"], ["OpenAI API Key", "OpenAI"], ["OpenRouter", "OpenRouter"]]
    .map(([name, shortName]) => ({ name: name!, shortName: shortName!, serving: name === serving }))
  for (const kind of ["models", "model"] as const) {
    const tier = kind === "models" ? " · mid" : ""
    const mounted = mountModelsSheet(kind)
    try {
      await mounted.ready()
      if (kind === "models") mounted.click("Chat")
      mounted.resolveOptions("gpt-5", true, chain("ChatGPT Subscription"))
      await mounted.ready()
      const first = mounted.detail("gpt-5")
      assert.equal(first.text, `ChatGPT +2${tier}`)
      assert.deepEqual(first.serving, ["ChatGPT"])

      await mounted.publishAuth(2)
      mounted.resolveOptions("gpt-5", true, chain("ChatGPT Subscription"))
      await mounted.ready()
      const equal = mounted.detail("gpt-5")
      assert.equal(equal.text, first.text)
      assert.equal(equal.elements.length, first.elements.length)
      assert.ok(equal.elements.every((element, index) => element === first.elements[index]), "an equal refresh keeps every detail element")

      await mounted.publishAuth(3)
      mounted.resolveOptions("gpt-5", true, chain("OpenAI API Key"))
      await mounted.ready()
      const moved = mounted.detail("gpt-5")
      assert.equal(moved.text, `ChatGPT → OpenAI +1${tier}`)
      assert.deepEqual(moved.serving, ["OpenAI"])
      assert.ok(first.elements.every((element, index) => element === moved.elements[index]), "a moved serving provider keeps the elements already shown")

      await mounted.publishAuth(4)
      mounted.resolveOptions("gpt-5", true, chain(undefined))
      await mounted.ready()
      assert.equal(mounted.detail("gpt-5").text, `ChatGPT → OpenAI → OpenRouter${tier}`)
      assert.deepEqual(mounted.detail("gpt-5").serving, [])
    } finally {
      mounted.dispose()
    }
  }
})

test("reset confirmation cannot cross into a newly selected session", async () => {
  const mounted = mountModelsSheet()
  try {
    await mounted.ready()
    mounted.click("Reset every role")
    await mounted.selectSession("session-b")
    mounted.settleConfirmation(true)
    await mounted.ready()

    assert.equal(mounted.mutations().length, 0)
  } finally {
    mounted.dispose()
  }
})

test("model options follow scoped eligibility without losing row identity or pending effort", async () => {
  const mounted = mountModelsSheet()
  try {
    await mounted.ready()
    mounted.click("Chat")
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    const row = mounted.row("kept-model")
    assert.ok(row)
    row.focus()
    const body = mounted.body()
    assert.ok(body)
    body.scrollTop = 123
    const queries = mounted.queryCount()
    await mounted.publishAuth(2, "other-session")
    assert.equal(mounted.queryCount(), queries)
    await mounted.publishAuth(2)
    assert.equal(mounted.queryCount(), queries + 1)
    assert.equal(mounted.row("kept-model"), row)
    assert.doesNotMatch(mounted.text(), /Reading/)
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    assert.equal(mounted.row("kept-model"), row)
    assert.equal(row.properties.focused, true)
    assert.equal(mounted.body(), body)
    assert.equal(body.scrollTop, 123)
    await mounted.publishAuth(2, "session-a", 3)
    assert.equal(mounted.queryCount(), queries + 1)
    await mounted.publishAuth(3, "session-a", 4)
    mounted.click("kept-model")
    mounted.resolveEfforts(2)
    await mounted.ready()
    mounted.resolveOptions("late-model")
    await mounted.ready()
    assert.match(mounted.text(), /Effort for Chat on kept-model/)
    assert.match(mounted.text(), /High/)
    assert.deepEqual(mounted.refreshes(), [{ type: "auth.catalog.refresh", scope: { kind: "session", sessionId: "session-a" } }])
  } finally {
    mounted.dispose()
  }
})

test("chat model refresh keeps focused rows, scroll and effort through discovery and failed reads", async () => {
  const mounted = mountModelsSheet("model")
  try {
    await mounted.ready()
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    const row = mounted.row("kept-model")
    const body = mounted.body()
    assert.ok(row)
    assert.ok(body)
    row.focus()
    body.scrollTop = 92
    await mounted.publishAuth(2)
    assert.equal(mounted.row("kept-model"), row)
    assert.doesNotMatch(mounted.text(), /Reading/)
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    assert.equal(mounted.row("kept-model"), row)
    assert.equal(row.properties.focused, true)
    assert.equal(mounted.body(), body)
    assert.equal(body.scrollTop, 92)
    await mounted.publishAuth(3)
    mounted.rejectOptions()
    await mounted.ready()
    assert.equal(mounted.row("kept-model"), row)
    mounted.click("kept-model")
    mounted.resolveEfforts(2)
    await mounted.ready()
    const effort = mounted.row("High")
    assert.ok(effort)
    await mounted.publishAuth(4)
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    assert.equal(mounted.row("High"), effort)
    assert.deepEqual(mounted.refreshes(), [{ type: "auth.catalog.refresh", scope: { kind: "session", sessionId: "session-a" } }])
  } finally {
    mounted.dispose()
  }
})

test("model surfaces seed their scoped cursor before saved reads and observe revisions during the first read", async () => {
  for (const kind of ["models", "model"] as const) {
    const mounted = mountModelsSheet(kind, { auth: true })
    try {
      await mounted.ready()
      assert.equal(mounted.queryCount(), 0)
      assert.equal(mounted.refreshes().length, 0)
      mounted.releaseAuth(2)
      await mounted.ready()
      assert.equal(mounted.queryCount(), 2)
      assert.deepEqual(mounted.refreshes(), [{ type: "auth.catalog.refresh", scope: { kind: "session", sessionId: "session-a" } }])
      if (kind === "model") {
        await mounted.publishAuth(3)
        assert.equal(mounted.queryCount(), 4)
        mounted.resolveOptions("stale-model")
        mounted.resolveOptions("fresh-model")
        await mounted.ready()
        assert.match(mounted.text(), /fresh-model/)
        assert.doesNotMatch(mounted.text(), /stale-model/)
      } else {
        mounted.click("Chat")
        const row = mounted.row("Chat")
        await mounted.publishAuth(3)
        mounted.resolveOptions("stale-model")
        await mounted.ready()
        assert.equal(mounted.queryCount(), 6)
        assert.equal(mounted.row("Chat"), row)
        assert.doesNotMatch(mounted.text(), /stale-model|Reading/)
        await mounted.publishAuth(3, "session-a", 4)
        assert.equal(mounted.queryCount(), 6)
        mounted.resolveOptions("fresh-model")
        await mounted.ready()
        assert.match(mounted.text(), /fresh-model/)
        assert.doesNotMatch(mounted.text(), /stale-model/)
        assert.equal(mounted.queryCount(), 6)
      }
    } finally {
      mounted.dispose()
    }
  }
})

test("Back during a held chat model save keeps the sheet open", async () => {
  const mounted = mountModelsSheet("model", { save: true })
  try {
    await mounted.ready()
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    mounted.click("kept-model")
    mounted.resolveEfforts(2)
    await mounted.ready()
    mounted.click("High")
    mounted.click("Back")
    mounted.releaseSave()
    await mounted.ready()
    assert.equal(mounted.mutations().length, 1)
    assert.equal(mounted.closed(), 0)
    assert.match(mounted.text(), /Model and effort: Session A/)
  } finally {
    mounted.dispose()
  }
})

test("Model and effort names the agent in view and saves its seat under that name", async () => {
  const mounted = mountModelsSheet("model", { sessionKind: "subagent" })
  try {
    await mounted.ready()
    assert.match(mounted.text(), /Model and effort: Session A/)
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    mounted.click("kept-model")
    mounted.resolveEfforts(1)
    await mounted.ready()
    assert.deepEqual(mounted.reports(), ["Session A: saved"])
  } finally {
    mounted.dispose()
  }
})

test("Model and effort offers the effort of the model in force and writes a picked effort once", async () => {
  const mounted = mountModelsSheet("model", { efforts: true })
  try {
    await mounted.ready()
    mounted.resolveOptions("kept-model")
    await mounted.ready()
    assert.match(mounted.text(), /Effort/)
    mounted.click("Max")
    assert.deepEqual(mounted.settingWrites, [{ kind: "set-effort", effort: "max" }])
  } finally {
    mounted.dispose()
  }
})

for (const kind of ["model", "models"] as const) {
  test(`${kind} shows a skipped saved setting outside choices and saves a reachable replacement`, async () => {
    const mounted = mountModelsSheet(kind, { savedModel: "lost-model" })
    try {
      await mounted.ready()
      if (kind === "models") mounted.click("Chat")
      mounted.resolveOptions("replacement-model")
      await mounted.ready()
      assert.match(mounted.text(), /Saved: lost-model/)
      assert.equal(mounted.row("lost-model"), undefined)
      mounted.click("replacement-model")
      mounted.resolveEfforts(1)
      await mounted.ready()
      assert.deepEqual(mounted.mutations().at(-1)?.scope, { kind: "session", sessionId: "session-a" })
      assert.equal(mounted.reports().some((message) => message.includes("not available")), false)
    } finally { mounted.dispose() }
  })

  for (const roleId of ["workflow-agent", "brief.plan", "brief.plan.persona.explorer", "brief.plan.at.worker"]) {
    test(`${kind} names the saving scope for ${roleId}`, async () => {
      const mounted = mountModelsSheet(kind, { roleId })
      try {
        await mounted.ready()
        if (kind === "models") mounted.click(roleId)
        mounted.resolveOptions("replacement-model")
        await mounted.ready()
        if (roleId === "workflow-agent") {
          assert.match(mounted.text(), /Auth profile/)
          assert.doesNotMatch(mounted.text(), /This session/)
        } else {
          assert.doesNotMatch(mounted.text(), /Auth profile/)
        }
        mounted.click("replacement-model")
        mounted.resolveEfforts(1)
        await mounted.ready()
        assert.deepEqual(mounted.mutations().at(-1)?.scope, { kind: "session", sessionId: "session-a" })
        assert.deepEqual(mounted.mutations().at(-1)?.slot, { kind: "role", roleId })
      } finally { mounted.dispose() }
    })
  }
}

for (const kind of ["model", "models"] as const) {
  test(`${kind === "model" ? "the chat model sheet" : "the Models sheet"} saves a second effort for the seat after the first, so the last tap lands last`, async () => {
    const mounted = mountModelsSheet(kind, { save: true })
    try {
      await mounted.ready()
      if (kind === "models") {
        mounted.click("Chat")
        await mounted.ready()
      }
      mounted.resolveOptions("kept-model")
      await mounted.ready()
      mounted.click("kept-model")
      mounted.resolveEfforts(2)
      await mounted.ready()
      mounted.click("High")
      mounted.click("Medium")
      await mounted.ready()
      const efforts = () => mounted.mutations().map((mutation) => "effort" in mutation ? mutation.effort : mutation.type)
      assert.deepEqual(efforts(), ["high"])
      mounted.releaseSave()
      await mounted.ready()
      assert.deepEqual(efforts(), ["high", "medium"])
      mounted.releaseSave()
      await mounted.ready()
    } finally {
      mounted.dispose()
    }
  })
}

test("a saved role returns to the roles list where the person left it", async () => {
  const mounted = mountModelsSheet()
  try {
    await mounted.ready()
    const body = mounted.body()
    assert.ok(body)
    const scrolled = (top: number) => {
      body.scrollTop = top
      const onScroll = body.properties.onScroll
      if (typeof onScroll === "function") onScroll({})
    }
    scrolled(240)
    mounted.click("Chat")
    mounted.resolveOptions("fresh-model")
    await mounted.ready()
    assert.equal(body.scrollTop, 0)
    scrolled(60)
    mounted.click("fresh-model")
    mounted.resolveEfforts(1)
    await mounted.ready()
    mounted.releaseSave()
    await mounted.ready()
    assert.match(mounted.text(), /Scope: this session/)
    assert.equal(body.scrollTop, 240)
  } finally {
    mounted.dispose()
  }
})
