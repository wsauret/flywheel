import * as fs from "node:fs"
import * as path from "node:path"
import { layout, openProject, replyTo, ROUTE_MARK, until, type StartedIds } from "./fixture.ts"

/** The branch steps of `scripts/lead-store-compat.ts`, run with the branch's
 *  code. `bun write-with-branch.ts <temp root> store` opens the lead, sends it
 *  one person message that the fake model routes to a new chat, waits for both
 *  turns, and writes the two chat ids. `... lead-off` turns the `lead` module
 *  off through the branch's settings mutation, as the Settings switch does. */

const [tempRoot, mode] = process.argv.slice(2)
if (!tempRoot || (mode !== "store" && mode !== "lead-off")) throw new Error("usage: write-with-branch.ts <temp root> store|lead-off")
const branchRoot = path.resolve(import.meta.dir, "../..")
const dirs = layout(tempRoot)
const project = await openProject(branchRoot, tempRoot, `branch-${mode}`)
const { client } = project

if (mode === "store") {
  const opened = await client.dispatch({ type: "lead.open", reason: "launch" })
  if (!opened.ok || !opened.sessionId) throw new Error(`lead.open opened no lead chat: ${JSON.stringify(opened)}`)
  const leadSessionId = opened.sessionId
  const request = `${ROUTE_MARK} please give this request to a new chat`
  await project.turn(leadSessionId, request, "COMPAT-ROUTED")
  const roster = await until("the started chat in the lead view", async () => (await client.query({ type: "snapshot" })).rows.map((row) => row.id).filter((id) => id !== leadSessionId), (ids) => ids.length > 0)
  if (roster.length !== 1) throw new Error(`the route started ${roster.length} chats, not one: ${roster.join(", ")}`)
  const startedSessionId = roster[0]!
  await until(`the forwarded turn in ${startedSessionId}`, () => project.assistantTexts(startedSessionId), (texts) => texts.some((text) => text.includes(replyTo(request))))
  await until(`${startedSessionId} at rest`, () => project.atRest(startedSessionId), Boolean)
  const ids: StartedIds = { leadSessionId, startedSessionId }
  fs.writeFileSync(dirs.ids, JSON.stringify(ids))
  console.log(`branch: lead chat ${leadSessionId} routed one person message to the new chat ${startedSessionId}`)
} else {
  const result = await client.dispatch({ type: "settings.set_module", moduleId: "lead", expected: true, enabled: false })
  if (!result.ok) throw new Error(`the branch refused to turn lead off: ${JSON.stringify(result)}`)
  const written = fs.readFileSync(path.join(dirs.userDataRoot, "flywheel.toml"), "utf8")
  console.log(`branch: settings.set_module turned lead off and wrote ${JSON.stringify(written.split("\n").find((line) => line.startsWith("disabled_modules")) ?? "(no disabled_modules line)")}`)
}

console.log(`branch: shutdown ${JSON.stringify(await project.close())}`)
process.exit(0)
