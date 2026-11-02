// Adapted from opencode `packages/core/src/codemode/tool.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
import type { Result } from "../../../infra/code-mode/codemode.js"
import { redactSecrets } from "../../../infra/redact-secrets.js"

/** The one model text for every Code Mode result: the guest's interpreter
 *  results and the host's synthesized timeout and runtime failures. The type
 *  import keeps the interpreter out of the host's module graph. */
export function formatCodeModeResult(result: Result): string {
  const output = result.ok
    ? typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value, null, 2) ?? String(result.value)
    : [result.error.message, ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))]
      .join("\n")
      .trim()
  const warnings = result.ok && result.warnings && result.warnings.length > 0
    ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
    : undefined
  const logs = result.logs && result.logs.length > 0
    ? `Logs:\n${redactSecrets(result.logs.join("\n"), { completeness: result.truncated ? "prefix" : "complete" })}`
    : undefined
  return redactSecrets([output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n"))
}
