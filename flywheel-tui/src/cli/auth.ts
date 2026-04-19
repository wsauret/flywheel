import * as fs from "node:fs"
import { errorMessage } from "../infra/error-message.js"
import { CONFIG_FILES } from "../infra/paths.js"
import { loadConfig } from "../orchestration/config/loader.js"

const USAGE = `Usage: flywheel auth <command>

Commands:
  login                    Authenticate with ChatGPT subscription (opens browser)
  login --email <email>    Pre-fill email on the login form
  login --headless         Authenticate via device code (no browser needed)
  status                   Show current authentication status
  logout                   Remove stored credentials`

function extractFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}

export async function runAuth(args: string[]): Promise<void> {
  const command = args[0]

  if (!command) {
    console.log(USAGE)
    return
  }

  switch (command) {
    case "login":
      await login(args.includes("--headless"), extractFlag(args, "--email"))
      break
    case "status":
      await status()
      break
    case "logout":
      await logout()
      break
    default:
      console.error(`Unknown auth command: ${command}\n`)
      console.log(USAGE)
      process.exit(1)
  }
}

function resolveEmail(cliEmail?: string): string | undefined {
  if (cliEmail) return cliEmail
  const configPath = CONFIG_FILES.find((p) => fs.existsSync(p))
  if (!configPath) return undefined
  return loadConfig(configPath).config.openai_email
}

async function login(headless: boolean, email?: string): Promise<void> {
  if (headless) {
    console.log("Starting device code flow...\n")
    const { startDeviceCodeFlow } = await import("../orchestration/auth/openai-oauth.js")
    try {
      const tokens = await startDeviceCodeFlow()
      console.log("\nLogged in via ChatGPT subscription")
      if (tokens.accountId) console.log(`  Account: ${tokens.accountId}`)
      console.log(`  Expires: ${new Date(tokens.expiresAtMs).toISOString()}`)
    } catch (err) {
      console.error(`Login failed: ${errorMessage(err)}`)
      process.exit(1)
    }
    return
  }

  const hint = resolveEmail(email)
  console.log("Opening browser for authentication...")
  const { startBrowserFlow } = await import("../orchestration/auth/openai-oauth.js")
  try {
    const tokens = await startBrowserFlow(hint)
    console.log("\nLogged in via ChatGPT subscription")
    if (tokens.accountId) console.log(`  Account: ${tokens.accountId}`)
    console.log(`  Expires: ${new Date(tokens.expiresAtMs).toISOString()}`)
  } catch (err) {
    console.error(`Login failed: ${errorMessage(err)}`)
    process.exit(1)
  }
}

async function status(): Promise<void> {
  const { loadStoredTokens, isTokenExpired } = await import(
    "../infra/auth/openai-token-store.js"
  )

  const tokens = loadStoredTokens()
  if (!tokens) {
    console.log("Not logged in. Run `flywheel auth login` to authenticate.")
    return
  }

  const expired = isTokenExpired(tokens)
  console.log(`ChatGPT subscription: ${expired ? "expired" : "active"}`)
  if (tokens.accountId) console.log(`  Account: ${tokens.accountId}`)
  console.log(`  Token expires: ${new Date(tokens.expiresAtMs).toISOString()}`)
}

async function logout(): Promise<void> {
  const { deleteStoredTokens } = await import("../infra/auth/openai-token-store.js")
  deleteStoredTokens()
  console.log("Logged out.")
}
