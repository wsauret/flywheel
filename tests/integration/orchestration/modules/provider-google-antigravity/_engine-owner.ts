/**
 * A Flywheel owner that the crash test kills: it launches one engine on the login `<root>/<login>`, opens a session,
 * sends a prompt whose answer the fake host holds back, prints `READY <pid> <session id>`, and waits to be killed.
 * Usage: `bun _engine-owner.ts <root> <login>`.
 */
import { openEngineHarness, text } from "./_engine.js"

const [root = "", login = ""] = process.argv.slice(2)
const harness = openEngineHarness(root)
const owned = await harness.login(login)
const engine = await owned.launch()
const opened = await engine.openSession({ onUpdate: () => {}, onToolCall: () => Promise.reject(new Error("no tools")) })
harness.fake.script([{ kind: "text", text: "late", delayMs: 600_000 }])
owned.gate.grant(opened.sessionId)
void engine.prompt(opened.sessionId, text("held prompt")).catch(() => {})
while (!harness.fake.requests.some(({ kind }) => kind === "main")) await Bun.sleep(20)
process.stdout.write(`READY ${String(process.pid)} ${opened.sessionId}\n`)
await new Promise(() => {})
