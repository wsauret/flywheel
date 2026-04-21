import type { Engine } from "./engines/core/types.js"
import { resolveModelTier } from "./config/model-tiers.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "session-title" })
const OPENAI_MODEL_RE = /^(gpt-|o\d|codex-|chatgpt-)/i

const TITLE_PROMPT = `Generate a title of 5 words or fewer that summarizes what this message is about. Output ONLY the title, nothing else. No quotes, no punctuation at the end, no explanation.

Message: `

const TITLE_TIMEOUT_MS = 10_000

interface TitleGeneratorDeps {
  engine: Engine
  projectCwd: string
  model?: string
}

function detectVendor(model: string | undefined): "anthropic" | "openai" | null {
  const lowered = model?.toLowerCase()
  if (!lowered) return null
  if (lowered.startsWith("claude-")) return "anthropic"
  if (OPENAI_MODEL_RE.test(lowered)) return "openai"
  return null
}

function resolveTitleModel(deps: TitleGeneratorDeps): string {
  if (deps.engine.metadata.id === "claude") return "haiku"
  const vendor = detectVendor(deps.model) ?? "anthropic"
  return resolveModelTier("cheap", "worker", vendor)
}

function resolveTitleModels(deps: TitleGeneratorDeps): string[] {
  const seen = new Set<string>()
  const models = [resolveTitleModel(deps), deps.model]
  return models.filter((model): model is string => {
    if (!model || seen.has(model)) return false
    seen.add(model)
    return true
  })
}

export function generateSessionTitle(
  message: string,
  onTitle: (title: string) => void,
  deps?: TitleGeneratorDeps,
): void {
  const words = message.trim().split(/\s+/)
  let quick = words.slice(0, 5).join(" ")
  if (quick.length > 40) quick = quick.slice(0, 37) + "..."
  else if (words.length > 5) quick += "..."
  onTitle(quick)

  if (deps) {
    generateViaLLM(message, deps).then((title) => {
      if (title) onTitle(title)
    }).catch((err) => {
      log.warn("title generation callback failed", { error: errorMessage(err) })
    })
  }
}

async function generateViaLLM(message: string, deps: TitleGeneratorDeps): Promise<string | null> {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return null
  const models = resolveTitleModels(deps)
  for (const [index, model] of models.entries()) {
    const title = await generateViaLLMWithModel(message, deps, model, index === models.length - 1)
    if (title) return title
  }
  return null
}

async function generateViaLLMWithModel(
  message: string,
  deps: TitleGeneratorDeps,
  model: string,
  isFinalAttempt: boolean,
): Promise<string | null> {
  const logFailure = (summary: string, detail: Record<string, unknown>): void => {
    if (isFinalAttempt) log.warn(summary, detail)
    else log.info(summary, detail)
  }
  try {
    const chunks: string[] = []
    const runner = deps.engine.createRunner({
      model,
      cwd: deps.projectCwd,
      onEvent: (event) => {
        if (event.type === "assistant" && event.data?.message?.content) {
          for (const block of event.data.message.content) {
            if (block.type === "text") chunks.push(block.text)
          }
        }
      },
    })

    runner.send(TITLE_PROMPT + message.slice(0, 200))

    const completed = await Promise.race([
      runner.done,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TITLE_TIMEOUT_MS)),
    ])

    if (completed === "timeout") {
      logFailure("title generation timed out", { model })
      runner.abort()
      return null
    }

    if (completed.failure) {
      logFailure("title generation attempt failed", {
        model,
        kind: completed.failure.kind,
        message: "message" in completed.failure ? completed.failure.message : undefined,
      })
      return null
    }

    const title = chunks.join("").trim()
    if (!title || title.length > 60) {
      logFailure("title generation produced empty or too long result", { model, length: title.length })
      return null
    }

    log.info("generated session title", { title, model })
    return title
  } catch (err) {
    logFailure("title generation failed", { model, error: errorMessage(err) })
    return null
  }
}
