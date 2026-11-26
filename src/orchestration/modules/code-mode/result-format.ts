// Adapted from opencode `packages/core/src/codemode/tool.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
import type { Diagnostic } from "psychoscript/effect"
import { redactSecrets } from "../../../infra/redact-secrets.js"

/** The end of one Code Mode program: its value or the diagnostic it failed
 *  with, and the console lines that the retention budget kept. */
export type CodeModeResult =
  | {
    readonly ok: true
    readonly value: unknown
    readonly warnings?: ReadonlyArray<Diagnostic>
    readonly logs?: ReadonlyArray<string>
    readonly truncated?: boolean
  }
  | {
    readonly ok: false
    readonly error: Diagnostic
    readonly logs?: ReadonlyArray<string>
    readonly truncated?: boolean
  }

/** The one model text for every Code Mode result: the guest's interpreter
 *  results and the host's synthesized timeout and runtime failures. The type
 *  import keeps the interpreter out of the host's module graph. */
export function formatCodeModeResult(result: CodeModeResult): string {
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
