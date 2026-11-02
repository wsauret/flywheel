import type { ToolRunStatus } from "./visible-output-blocks.js"

// Tool-run headings are always past tense; the spinner already signals "in flight".
export function exploreRunLabel(status: ToolRunStatus): string {
  return status === "paused" ? "Interrupted" : "Explored"
}

export function execRunLabel(status: ToolRunStatus): string {
  return status === "paused" ? "Interrupted" : "Ran"
}

export function executedRunLabel(status: ToolRunStatus): string {
  return status === "paused" ? "Interrupted" : "Executed"
}
