import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { attachTuiUat, openTuiUatWeb, reapTuiUat, searchTuiUatEvents, startTuiUat, stopTuiUat, type TuiUatApp } from "./harness.js"
import { PanePollError } from "./tmux-driver.js"

const HELP = `Installed Flywheel TUI UAT

bun run uat:tui start --scratch-root <own-session-scratch> [--source-project-root <cwd>]
  [--config <file>] [--env K=V ...] [--no-auth] [--idle-timeout <milliseconds>]
  [--installation-home <home>]
  Starts an isolated installed TUI. Prints the sandbox root handle and first pane.
  --installation-home names the HOME of a FLYWHEEL_INSTALLED_BINARY installed
  outside your own, whose active build the sandbox runs.
  The session-owned reaper stops it after 1200000ms without a verb call.

bun run uat:tui <verb> <handle> [arguments]
  type <text>                Type literal text without submitting.
  submit                     Submit the draft once.
  keys <key> ...             Send tmux key names, such as Escape or C-p.
  click <text> [--last]       Click visible text, optionally its last occurrence.
  click <col> <row>           Click one-based pane coordinates.
  capture [name]             Print the pane; optionally save it in evidence/.
  history [name]             Print full history; optionally save it in evidence/.
  wait <text> [--regex] [--timeout <milliseconds>]
                             Wait for literal text or a regular expression.
  events <args> ...          Run installed flywheel events search in the sandbox.
  web                        Run installed flywheel web in the sandbox and print
                             the sandbox hub address it opened.
  stop                       End the process tree and remove HOME and credentials.

Every action prints the resulting pane. Failures print the last observed pane.
Evidence and the isolated project remain after stop. Never pass secrets via --env.
`

function milliseconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("timeout must be a positive number of milliseconds")
  return parsed
}

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2)
  if (!verb || verb === "--help" || verb === "help") {
    console.log(HELP)
    return
  }
  if (verb === "start") {
    const { values } = parseArgs({
      args,
      options: {
        "scratch-root": { type: "string" },
        "source-project-root": { type: "string" },
        config: { type: "string" },
        env: { type: "string", multiple: true },
        "no-auth": { type: "boolean" },
        "idle-timeout": { type: "string" },
        "installation-home": { type: "string" },
      },
    })
    if (!values["scratch-root"]) throw new Error("start requires --scratch-root pointing to your own session scratchpad")
    const env: { [name: string]: string } = {}
    for (const entry of values.env ?? []) {
      const equals = entry.indexOf("=")
      if (equals < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.slice(0, equals))) throw new Error("--env requires K=V")
      env[entry.slice(0, equals)] = entry.slice(equals + 1)
    }
    const app = await startTuiUat({
      scratchRoot: resolve(values["scratch-root"]),
      sourceProjectRoot: resolve(values["source-project-root"] ?? process.cwd()),
      config: values.config === undefined ? undefined : await readFile(values.config, "utf8"),
      cloneAuth: !values["no-auth"],
      nonSecretEnv: env,
      idleTimeoutMs: milliseconds(values["idle-timeout"], 20 * 60_000),
      installationHome: values["installation-home"] === undefined ? undefined : resolve(values["installation-home"]),
    })
    console.log(`Handle: ${app.sandbox.root}\nSession: ${app.sessionName}\nServer: ${app.sandbox.tmuxServer}\n${app.capture()}`)
    return
  }
  const [root, ...rest] = args
  if (!root) throw new Error(`${verb} requires a sandbox root handle`)
  if (verb === "_reap") {
    await reapTuiUat(root)
    return
  }
  let app: TuiUatApp | undefined
  try {
    app = await attachTuiUat(root)
    switch (verb) {
      case "type":
        if (rest.length !== 1) throw new Error("type requires one quoted text argument")
        app.sendLiteral(rest[0]!)
        break
      case "submit":
        await app.submit()
        break
      case "keys":
        if (!rest.length) throw new Error("keys requires at least one key name")
        app.sendKeys(...rest)
        break
      case "click": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { last: { type: "boolean" } } })
        if (positionals.length === 2) app.click(Number(positionals[0]), Number(positionals[1]))
        else if (positionals.length === 1) app.clickText(positionals[0]!, values.last)
        else throw new Error("click requires quoted visible text or col row")
        break
      }
      case "capture":
        if (rest[0]) console.log(`Evidence: ${await app.captureArtifact(rest[0])}`)
        break
      case "history":
        if (rest[0]) console.log(`Evidence: ${await app.captureHistoryArtifact(rest[0])}`)
        console.log(app.captureHistory())
        break
      case "wait": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { regex: { type: "boolean" }, timeout: { type: "string" } } })
        if (positionals.length !== 1) throw new Error("wait requires quoted text or a regex with --regex")
        const text = positionals[0]!
        const regex = values.regex ? new RegExp(text, "u") : undefined
        await app.pollPane(text, (pane) => regex ? regex.test(pane) : pane.includes(text), milliseconds(values.timeout, 30_000))
        break
      }
      case "events":
        console.log(await searchTuiUatEvents(root, rest))
        break
      case "web":
        console.log(await openTuiUatWeb(root))
        break
      case "stop":
        try { console.log(app.capture()) } catch { /* Stop still owns cleanup when the app pane has exited. */ }
        await stopTuiUat(root)
        console.log(`Stopped: ${root}; HOME removed`)
        return
      default:
        throw new Error(`unknown verb: ${verb}; use --help`)
    }
    if (verb === "type" || verb === "submit" || verb === "keys" || verb === "click") await Bun.sleep(100)
    try {
      console.log(app.capture())
    } catch (error) {
      if (verb !== "keys" || app.hasPane()) throw error
      console.log("App pane exited")
    }
  } catch (error) {
    if (error instanceof PanePollError) console.error(error.lastCapture)
    else if (app) {
      try { console.error(app.capture()) } catch { /* The pane may have exited. */ }
    }
    throw error
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof PanePollError ? error.message.replace(`; last pane:\n${error.lastCapture}`, "") : error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
