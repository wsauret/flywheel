import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { FrontendQuestionBlock } from "../client/question-answer.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("question-panel-fixture.tsx", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  format: "esm",
  plugins: [{
    name: "question-panel-memory-host",
    setup(builder) {
      builder.onLoad({ filter: /[\\/]client-context\.ts$/ }, () => ({
        contents: "export function useClient() { return Reflect.get(globalThis, '__flywheelQuestionPanelTestClient') }",
        loader: "js",
      }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((candidate) => candidate.kind === "entry-point")
if (!output) throw new Error("Question panel fixture build produced no JavaScript")
const fixture: typeof import("./question-panel-fixture.js") =
  await importBuiltModule(output)

const COLOR_AND_FRUIT: FrontendQuestionBlock["questions"] = [
  {
    question: "Which color do you prefer?", header: "Color", multiSelect: false,
    choices: [{ kind: "option", choiceId: "red", label: "Red" }, { kind: "option", choiceId: "blue", label: "Blue" }, { kind: "freeform", label: "Other" }],
  },
  {
    question: "Which fruit do you prefer?", header: "Fruit", multiSelect: false,
    choices: [{ kind: "option", choiceId: "apple", label: "Apple" }, { kind: "freeform", label: "Other" }],
  },
]

test("opening Other keeps the pick until the person types there", async () => {
  const mounted = fixture.mountQuestionPanel([COLOR_AND_FRUIT[0]!])
  try {
    mounted.pick("Red")
    mounted.pick("Other")
    await mounted.settle()
    assert.equal(mounted.checked("Red"), true)
    assert.equal(mounted.checked("Other"), false)

    mounted.type("Other", "teal")
    assert.equal(mounted.checked("Red"), false)
    assert.equal(mounted.checked("Other"), true)
  } finally {
    mounted.dispose()
  }
})

test("a text entry is a field that wraps and grows with what is typed", async () => {
  const mounted = fixture.mountQuestionPanel([{
    question: "How should it deploy?", header: "Deploy", multiSelect: false,
    choices: [{ kind: "option", choiceId: "custom", label: "Custom", requiresText: true }, { kind: "option", choiceId: "default", label: "Default" }, { kind: "freeform", label: "Other" }],
  }])
  try {
    mounted.pick("Custom")
    await mounted.settle()
    const field = mounted.field("Custom")
    assert.equal(field.tag, "textarea")
    Object.assign(field, { scrollHeight: 120, offsetHeight: 34, clientHeight: 32 })
    mounted.type("Custom", "a long answer ".repeat(20))
    assert.equal(field.style.height, "122px")
  } finally {
    mounted.dispose()
  }
})

test("a minimized panel of several questions counts them, and a notification tap expands it again", async () => {
  const mounted = fixture.mountQuestionPanel(COLOR_AND_FRUIT)
  try {
    mounted.minimize()
    assert.equal(mounted.collapsedStrip(), "2 questionsColor · Fruit")
    mounted.attend()
    await mounted.settle()
    assert.equal(mounted.collapsedStrip(), undefined)
    mounted.minimize()
    mounted.attend()
    await mounted.settle()
    assert.equal(mounted.collapsedStrip(), undefined)
  } finally {
    mounted.dispose()
  }
})

test("a minimized panel of one question names its header and its text", () => {
  const mounted = fixture.mountQuestionPanel([COLOR_AND_FRUIT[0]!])
  try {
    mounted.minimize()
    assert.equal(mounted.collapsedStrip(), "ColorWhich color do you prefer?")
  } finally {
    mounted.dispose()
  }
})
