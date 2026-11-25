type Report = (severity: "info" | "warning", message: string) => void

/** Copies one canonical session ID through the current host's clipboard. */
export async function copySessionId(writeText: (text: string) => Promise<void>, report: Report, sessionId: string): Promise<void> {
  try {
    await writeText(sessionId)
    report("info", "Session ID copied.")
  } catch {
    report("warning", "Could not copy the session ID. Check clipboard access and try again.")
  }
}
