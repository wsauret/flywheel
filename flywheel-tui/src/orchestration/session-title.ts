/**
 * Session Title Generation — generates concise session titles via a lightweight LLM call.
 *
 * Used by both chat and workflow sessions. Calls `onTitle` twice:
 * 1. Immediately with a quick first-5-words title (so the UI isn't blank)
 * 2. Async with a haiku-generated <= 5 word summary (replaces the quick title)
 *
 * If the LLM call fails or times out, the quick title stands.
 */

import { BunProcessSpawner } from "./engines/subprocess/bun-spawner"
import { getEngine } from "./engines/core/registry"
import { Log } from "../infra/log"

const log = Log.create({ service: "session-title" })

const TITLE_PROMPT = `Generate a title of 5 words or fewer that summarizes what this message is about. Output ONLY the title, nothing else. No quotes, no punctuation at the end, no explanation.

Message: `

const TITLE_TIMEOUT_MS = 10_000

/**
 * Generate a session title from a user message or description.
 *
 * Calls `onTitle` immediately with a quick fallback (first 5 words),
 * then fires a haiku subprocess in parallel and calls `onTitle` again
 * with the LLM-generated title when ready.
 */
export function generateSessionTitle(message: string, onTitle: (title: string) => void): void {
  // Immediate: first 5 words
  const words = message.trim().split(/\s+/)
  let quick = words.slice(0, 5).join(" ")
  if (quick.length > 40) quick = quick.slice(0, 37) + "..."
  else if (words.length > 5) quick += "..."
  onTitle(quick)

  // Async: haiku-generated title (fire-and-forget)
  generateViaLLM(message).then((title) => {
    if (title) onTitle(title)
  })
}

async function generateViaLLM(message: string): Promise<string | null> {
  try {
    const engine = getEngine("claude")
    const cmd = engine.buildCommand({ model: "haiku" })

    const args = [
      "-p", TITLE_PROMPT + message.slice(0, 200),
      "--model", "haiku",
      "--output-format", "text",
      "--dangerously-skip-permissions",
    ]

    const spawner = new BunProcessSpawner()
    let output = ""

    const result = await spawner.spawn(cmd.command, args, {
      cwd: process.cwd(),
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
    log.warn("title generation failed", { error: String(err) })
    return null
  }
}
