/**
 * Agent Loader — reads persona .md files and builds the --agents JSON
 * for Claude Code's --bare mode.
 *
 * Claude's --agents flag expects:
 *   {"agent-name": {"description": "...", "prompt": "..."}}
 *
 * Each persona file has YAML frontmatter (name, description, model, tools)
 * and a markdown body that becomes the prompt.
 */

import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import { parseFrontmatter } from "../../orchestration/utils/frontmatter.js"
import { Log } from "../shared/log.js"
import { errorMessage } from "../shared/error-message.js"

const log = Log.create({ service: "agent-loader" })

export interface AgentDefinition {
  description: string
  prompt: string
  model?: string
  tools?: string[]
}

export type AgentMap = Record<string, AgentDefinition>

function getSourceDir(): string {
  const thisDir = new URL(".", import.meta.url).pathname
  return join(thisDir, "personas", "fly")
}

let cachedJson: string | null = null

/**
 * Load all persona .md files and return a serialized JSON string
 * suitable for the --agents CLI flag.
 *
 * Reads synchronously from the bundled personas directory.
 * Caches after first call. Returns empty JSON object on failure.
 */
export function loadAgentsJson(): string {
  if (cachedJson !== null) return cachedJson

  const sourceDir = getSourceDir()
  const agents: AgentMap = {}

  let files: string[]
  try {
    files = readdirSync(sourceDir).filter(f => f.endsWith(".md"))
  } catch (err) {
    log.warn("failed to read agent personas directory", { error: errorMessage(err) })
    cachedJson = "{}"
    return cachedJson
  }

  for (const file of files) {
    try {
      const content = readFileSync(join(sourceDir, file), "utf-8")
      const parsed = parseFrontmatter(content)
      if (!parsed) continue

      const { frontmatter, body } = parsed
      const name = typeof frontmatter.name === "string" ? frontmatter.name : file.replace(/\.md$/, "")
      const description = typeof frontmatter.description === "string" ? frontmatter.description : ""

      const def: AgentDefinition = { description, prompt: body.trim() }

      if (typeof frontmatter.model === "string") {
        def.model = frontmatter.model
      }
      if (Array.isArray(frontmatter.tools)) {
        def.tools = frontmatter.tools.map(String)
      }

      agents[name] = def
    } catch (err) {
      log.warn("failed to load agent persona", { file, error: errorMessage(err) })
    }
  }

  log.info("loaded agent definitions", { count: Object.keys(agents).length })
  cachedJson = JSON.stringify(agents)
  return cachedJson
}
