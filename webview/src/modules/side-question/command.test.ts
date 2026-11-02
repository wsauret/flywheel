import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { SIDE_QUESTION_COMMAND } from "../../../../src/protocol/modules/side-question.js"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../../app/composer-submission-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "side-question-composer", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find((item) => item.kind === "entry-point")
if (!output) throw new Error("Missing composer build")
const { mountComposerSubmission }: typeof import("../../app/composer-submission-fixture.js") = await importBuiltModule(output)
const catalog = {
  revision: 3, offCommands: [],
  builtInCommands: [{ id: SIDE_QUESTION_COMMAND, title: "Side question", description: "Ask a side question", aliases: [] }],
}

test("side question: typed slash arguments and the menu entry invoke the command without parent messages", () => {
  const mounted = mountComposerSubmission({ catalog })
  try {
    mounted.type(`/${SIDE_QUESTION_COMMAND} Explain this`)
    mounted.enter()
    assert.deepEqual(mounted.commands, [{ name: SIDE_QUESTION_COMMAND, args: "Explain this" }])
    assert.deepEqual(mounted.sent, [])
    mounted.type(`/${SIDE_QUESTION_COMMAND}`)
    assert.deepEqual(mounted.selected(), ["Side question"])
    mounted.enter()
    assert.deepEqual(mounted.commands.at(-1), { name: SIDE_QUESTION_COMMAND, args: undefined })
    assert.equal(mounted.text(), "")
    assert.deepEqual(mounted.sent, [])
  } finally { mounted.dispose() }
})
