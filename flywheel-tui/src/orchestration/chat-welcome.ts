/**
 * Chat welcome blocks — first-run presentation for new chat sessions.
 *
 * Extracted from chat-runner.ts for SRP: the runner owns subprocess lifecycle,
 * this module owns the welcome UX (font detection, tip display).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AnyBlock } from "../infra/output-blocks.js";

function isMonaspaceInstalled(): boolean {
  if (process.platform === "darwin") {
    const userFonts = join(homedir(), "Library", "Fonts")
    const systemFonts = "/Library/Fonts"
    return existsSync(join(userFonts, "MonaspaceArgon-Regular.otf"))
      || existsSync(join(systemFonts, "MonaspaceArgon-Regular.otf"))
  }
  if (process.platform === "linux") {
    const localFonts = join(homedir(), ".local", "share", "fonts")
    return existsSync(join(localFonts, "MonaspaceArgon-Regular.otf"))
  }
  const winFonts = join(process.env.WINDIR ?? "C:\\Windows", "Fonts")
  return existsSync(join(winFonts, "MonaspaceArgon-Regular.otf"))
}

function getFontTipBlock(projectCwd: string, timestamp: number): AnyBlock | null {
  const flagPath = join(projectCwd, ".flywheel", "font-tip-seen")
  if (existsSync(flagPath)) return null

  try {
    mkdirSync(join(projectCwd, ".flywheel"), { recursive: true })
    writeFileSync(flagPath, "")
  } catch { /* best-effort */ }

  if (isMonaspaceInstalled()) {
    return {
      kind: "system",
      message: "Tip: Set Monaspace Argon as your terminal font for the best Flywheel experience.",
      timestamp,
    }
  }

  const installCmd = process.platform === "darwin"
    ? "`brew install --cask font-monaspace`"
    : process.platform === "linux"
      ? "https://github.com/githubnext/monaspace"
      : "`winget install GitHub.Monaspace`"

  return {
    kind: "system",
    message: `Tip: Install Monaspace Argon and set it as your terminal font — ${installCmd}`,
    timestamp,
  }
}

/** Build the initial welcome blocks for a fresh chat session. */
export function buildChatWelcomeBlocks(projectCwd: string): AnyBlock[] {
  const now = Date.now()
  const welcomeBlock: AnyBlock = {
    kind: "system",
    message: [
      "Hey. Start typing to chat, or try a command:",
      "",
      "  `/work` · `/sprint`",
      "",
      "`Ctrl+B` sessions · `Ctrl+N` new chat",
    ].join("\n"),
    timestamp: now,
  }

  const blocks: AnyBlock[] = [welcomeBlock]
  const fontTip = getFontTipBlock(projectCwd, now)
  if (fontTip) blocks.push(fontTip)
  return blocks
}
