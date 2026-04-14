import type { Engine } from "./engines/core/types.js"
import type { ProcessSpawner } from "./engines/subprocess/spawner.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "session-title" })

const TITLE_PROMPT = `Generate a title of 5 words or fewer that summarizes what this message is about. Output ONLY the title, nothing else. No quotes, no punctuation at the end, no explanation.

Message: `

const TITLE_TIMEOUT_MS = 10_000

interface TitleGeneratorDeps {
  engine: Engine
  spawner: ProcessSpawner
  projectCwd: string
}

export function generateSessionTitle(
  message: string,
  onTitle: (title: string) => void,
  deps: TitleGeneratorDeps,
): void {
  const words = message.trim().split(/\s+/)
  let quick = words.slice(0, 5).join(" ")
  if (quick.length > 40) quick = quick.slice(0, 37) + "..."
  else if (words.length > 5) quick += "..."
  onTitle(quick)

  generateViaLLM(message, deps).then((title) => {
    if (title) onTitle(title)
  })
}

async function generateViaLLM(message: string, deps: TitleGeneratorDeps): Promise<string | null> {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return null
  try {
    const cmd = deps.engine.buildCommand({ model: "haiku" })

    const args = [
      "-p", TITLE_PROMPT + message.slice(0, 200),
      "--model", "haiku",
      "--output-format", "text",
      "--dangerously-skip-permissions",
    ]

    let output = ""
    const result = await deps.spawner.spawn(cmd.command, args, {
      cwd: deps.projectCwd,
      onStdout: (chunk) => { output += chunk },
      onStderr: () => {},
    })

    const completed = await Promise.race([
      result.result.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), TITLE_TIMEOUT_MS)),
    ])

    if (!completed) {
      log.warn("title generation timed out")
      if (result.pid) try { process.kill(result.pid, "SIGTERM") } catch { /* already gone */ }
      return null
    }

    const title = output.trim()
    if (!title || title.length > 60) {
      log.warn("title generation produced empty or too long result", { length: title.length })
      return null
    }

    log.info("generated session title", { title })
    return title
  } catch (err) {
    log.warn("title generation failed", { error: errorMessage(err) })
    return null
  }
}
