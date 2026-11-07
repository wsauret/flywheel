import { isAbsolute, relative, resolve } from "node:path"
import { refusedShellWrite } from "../../agent-runtime/tools/bash-command-policy.js"
import type { ToolExecutionGate, ToolExecutionGateInput } from "../../agent-runtime/tools/tool-dispatch.js"
import type { ExperimentGuardSnapshot } from "../../agent-runtime/tools/types.js"
import { experimentsRuntime } from "./runtime.js"
import { EXPERIMENT_CHARTER_PATH } from "./charter.js"
import { charterPathConflict, isCharterPathMatch, physicalCharter } from "./protected-paths.js"
import { hasKind } from "../../agent-runtime/tools/tool-paths.js"

type Decision = { readonly kind: "allow" } | { readonly kind: "veto"; readonly reason: string }

function displayPath(path: string, workDir: string): string {
  const displayed = isAbsolute(path) ? relative(resolve(workDir), path) : path
  return displayed.replaceAll("\\", "/")
}

function veto(path: string, workDir: string): Decision {
  return { kind: "veto", reason: `experiment guard: ${displayPath(path, workDir)} is protected by the charter` }
}

function beforeInitAllowed(input: ToolExecutionGateInput): boolean {
  if (input.tool === "init_experiment") return true
  return input.tool === "read" && input.input.path === EXPERIMENT_CHARTER_PATH
}

/** The charter-policy gate the experiments module registers on the toolExecution
 *  seam. It reads the guard from its own runtime, so a runner without one
 *  (workflow workers, subagents) is allowed. */
export const experimentToolExecutionGate: ToolExecutionGate = async (input): Promise<Decision> => {
  const guard = await input.modules.get(experimentsRuntime)?.guard()
  if (!guard?.active) return { kind: "allow" }
  if (!guard.initialized && !beforeInitAllowed(input)) return veto("experiment is not initialized", guard.workDir)

  if (input.tool === "edit" || input.tool === "write") {
    // Reserved paths are physical, so the charter is compared in the same form.
    const charter = physicalCharter(guard.protectedPaths, guard.workDir)
    const protectedPath = input.preparedReservedPaths.find((path) => isCharterPathMatch(path, charter.patterns, charter.workDir))
    if (protectedPath) return veto(protectedPath, charter.workDir)
  }
  if (input.tool === "read" && typeof input.input.path === "string" && isCharterPathMatch(input.input.path, guard.sealedPaths, guard.workDir)) {
    return veto(input.input.path, guard.workDir)
  }
  if (input.tool === "read") {
    for (const path of input.preparedReservedPaths) {
      if (isCharterPathMatch(path, guard.sealedPaths, guard.workDir)) return veto(path, guard.workDir)
      if (typeof input.input.pattern === "string" || hasKind(path, "directory")) {
        const conflict = charterPathConflict(path, guard.sealedPaths, guard.workDir)
        if (conflict) return veto(conflict, guard.workDir)
      }
    }
  }
  if (input.tool === "search") {
    const root = typeof input.input.path === "string" ? input.input.path : "."
    const conflict = charterPathConflict(root, guard.sealedPaths, guard.workDir)
    if (conflict) return veto(conflict, guard.workDir)
  }
  if (input.shell) {
    // The write analyzer places targets physically, so the charter is compared in the same form.
    const charter = physicalCharter(guard.protectedPaths, guard.workDir)
    const target = await refusedShellWrite(input.shell.command, input.shell.cwd, (path) => charterPathConflict(path, charter.patterns, charter.workDir) === null)
    if (target) return veto(target, charter.workDir)
  }
  if (input.tool === "subagent") return veto("subagent", guard.workDir)
  return { kind: "allow" }
}

/** Request-planning omissions required to keep charter boundaries honest. */
export function experimentToolOmissions(snapshot: ExperimentGuardSnapshot): ReadonlyMap<string, string> {
  const omissions = new Map<string, string>()
  if (snapshot.sealedPaths.length > 0) omissions.set("bash", "sealed experiment paths cannot be exposed to a shell")
  if (snapshot.active) omissions.set("subagent", "active experiment policy cannot be delegated")
  return omissions
}
