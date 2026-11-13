import { MAIN_TURN_TEXT, openProject, readIds, replyTo } from "./fixture.ts"

/** The main-checkout step of `scripts/lead-store-compat.ts`:
 *  `bun read-with-main.ts <temp root> <main root> <label>` opens the store that
 *  the branch wrote with the code of the checkout at `<main root>`, prints the
 *  chats it lists, the module selection and config status it reports, and runs
 *  one turn in the chat that the lead started. It exits 2 when the main code
 *  refuses to open the project, and 1 when the chats are not both listed, the
 *  started chat has a parent, or the turn does not end with the fake model's
 *  text. */

const [tempRoot, mainRoot, label] = process.argv.slice(2)
if (!tempRoot || !mainRoot || !label) throw new Error("usage: read-with-main.ts <temp root> <main root> <label>")
const { leadSessionId, startedSessionId } = readIds(tempRoot)
const project = await openProject(mainRoot, tempRoot, `main-${label}`).catch((error: unknown) => {
  console.log(`main: REFUSED to open the project: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(2)
})
const { client } = project
const failures: string[] = []

const rows = (await client.query({ type: "snapshot" })).rows
for (const row of rows) console.log(`main: lists chat ${row.id} "${row.title}" lifecycle=${row.lifecycleState} parent=${row.parentSessionId ?? "none"}`)
for (const [name, id] of [["lead", leadSessionId], ["started", startedSessionId]] as const) {
  if (!rows.some((row) => row.id === id)) failures.push(`the ${name} chat ${id} is not listed`)
}
const started = rows.find((row) => row.id === startedSessionId)
if (started?.parentSessionId) failures.push(`the started chat has the parent ${started.parentSessionId}`)

const modules = (await client.query({ type: "moduleSnapshot" })).capabilities
const off = modules.modules.filter((row) => row.installed && !row.effective).map((row) => row.id)
console.log(`main: modules ${modules.capabilities.length} on, off [${off.join(", ")}], selection warnings ${JSON.stringify(modules.warnings)}, descriptor ${modules.descriptorIdentity}`)
const outcome = [
  ...(modules.descriptorIdentity.startsWith("invalid:") ? ["the selection is invalid"] : []),
  ...(modules.warnings.length > 0 ? [`a warning (${modules.warnings.join(" ")})`] : []),
  off.length === 0 ? "every module on" : `${off.length} modules off`,
]
console.log(`main: what the main code does with this module selection: ${outcome.join(", ")}`)
const { config } = await client.query({ type: "configSnapshot" })
console.log(`main: config status ${JSON.stringify({ status: config.status, moduleSelection: config.values.moduleSelection, warnings: config.warnings, diagnostics: config.diagnostics })}`)

const text = `${MAIN_TURN_TEXT} ${label}`
try {
  await project.turn(startedSessionId, text, replyTo(text))
  console.log(`main: the started chat ran one turn that ended with "${replyTo(text)}"`)
} catch (error) {
  failures.push(`the turn in the started chat did not complete: ${String(error)}`)
}

console.log(`main: shutdown ${JSON.stringify(await project.close())}`)
for (const failure of failures) console.log(`main: FAILED ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
