import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { createCliLauncher, type CliLauncher } from "../../src/cli/runtime-launch.js"
import { createBackgroundExecutionOwner } from "../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../src/orchestration/agent-runtime/background-work.js"
import { createForegroundBashHoldController } from "../../src/orchestration/agent-runtime/foreground-bash-hold.js"
import { planToolExposure } from "../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js"
import type { CapabilityAccess, RuntimeTool, ToolContext, ToolResult } from "../../src/orchestration/agent-runtime/tools/types.js"
import { NO_MODULE_RUNTIMES } from "../../src/infra/module-runtime.js"
import { captureRuntimeConfigRequest } from "../../src/orchestration/agent-runtime/request-config.js"
import { CONFIG_DEFAULTS } from "../../src/orchestration/config/schema.js"
import { composeFirstPartyModules } from "../../src/orchestration/modules.js"
import { definitionAvailabilityOf } from "../../src/orchestration/app-service/definition-availability.js"
import { contributedToolIdentities, treeCapabilityCheck } from "../../src/orchestration/agent-runtime/capability-checks.js"
import { publishSkillRevision } from "../../src/workflows/skill-schema.js"

const workspace = "/tmp/flywheel-linux-runtime-verification"
const scratchDir = join(workspace, "scratch")
const selected = new Set(["bash", "read", "write", "edit", "search", "list"])
const notifications: string[] = []
const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
  kind: "chat",
  enqueueNotification: (text: string) => { notifications.push(text) },
}))
const foregroundBashHold = createForegroundBashHoldController(() => {})
const capabilityAccess: CapabilityAccess = {
  available: (capability) => capability === "background-commands",
  admit: async (request) => ({
    ok: true,
    grant: {
      operation: request.operation,
      required: request.required,
      capabilities: ["background-commands"],
      moduleIds: ["background-commands"],
      requireWorkflowConfirmation: false,
      workflowsMode: "on",
      identity: "background-commands",
    },
  }),
}
const moduleSnapshot = composeFirstPartyModules()
// The smoke runs file and shell tools only, so it holds no skill or persona.
const definitionAvailability = definitionAvailabilityOf({
  skills: publishSkillRevision(1, new Map()),
  personaRevision: { revision: "none", personas: new Map(), resolutions: [] },
  personas: new Map(),
  resolutions: [],
}, moduleSnapshot.enabledModuleIds, [])
const tools = (await planToolExposure({
  kernel: {
    userDataRoot: workspace,
    backgroundTasks: background.tasks,
    foregroundBashHold,
    foregroundBashHoldSeconds: 10,
    shellWriteGuard: true,
    persistentProcessesAdvertised: false,
    capabilities: capabilityAccess,
    definitionAvailability: { tree: definitionAvailability, live: definitionAvailability },
    treeCapabilities: treeCapabilityCheck(moduleSnapshot, definitionAvailability, contributedToolIdentities(moduleSnapshot)),
    moduleSnapshot,
    runtimeConfig: captureRuntimeConfigRequest({ revision: 0, config: CONFIG_DEFAULTS, warnings: [], diagnostics: [], sourceIdentity: "smoke", status: { kind: "valid" } }, "default"),
    purpose: { kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } },
    servingModel: { model: "smoke", modelFamily: "anthropic" },
  },
  modules: NO_MODULE_RUNTIMES,
  selected,
})).tools
const context: ToolContext = {
  executionCwd: workspace,
  userDataRoot: join(workspace, ".test-account"),
  projectRoot: workspace,
  scratchDir,
  artifactScopeId: "linux-runtime-verification",
  retrievalSessionId: "linux-runtime-verification",
  sessionId: "linux-runtime-verification",
  backgroundTasks: background.tasks,
  foregroundBashHold,
  shell: background.shell,
  backgroundSignal: background.signal,
  disposalSignal: background.signal,
  capabilityAccess,
  availableTools: new Set(tools.keys()),
}

let failures = 0

function text(result: ToolResult): string {
  return typeof result.content === "string"
    ? result.content
    : result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
}

function tool(name: string): RuntimeTool {
  const definition = tools.get(name)
  if (!definition) throw new Error(`tool registry does not contain ${name}`)
  return definition
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function optionalNativeCheck(name: string, run: () => Promise<ToolResult>): Promise<void> {
  try {
    const result = await run()
    if (result.outcome === "ok") {
      console.log(`PASS ${name}`)
      return
    }
    const message = text(result)
    if (/native|addon|ripgrep|shared object|module not found|cannot find module/i.test(message)) {
      console.log(`SKIP ${name}: ${message.replaceAll("\n", " ")}`)
      return
    }
    failures++
    console.log(`FAIL ${name}: outcome=${result.outcome}: ${message.replaceAll("\n", " ")}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/native|addon|ripgrep|shared object|module not found|cannot find module/i.test(message)) {
      console.log(`SKIP ${name}: ${message.replaceAll("\n", " ")}`)
      return
    }
    failures++
    console.log(`FAIL ${name}: ${message}`)
  }
}

function requireOk(result: ToolResult): void {
  if (result.outcome !== "ok") throw new Error(`outcome=${result.outcome}: ${text(result).replaceAll("\n", " ")}`)
}

await rm(workspace, { recursive: true, force: true })
await mkdir(scratchDir, { recursive: true })

let launcher: CliLauncher | undefined
try {
  try {
    launcher = await createCliLauncher()
    context.spawnOwned = launcher.scope.spawnOwned
  } catch (error) {
    console.log(`FAIL launcher setup: ${error instanceof Error ? error.message : String(error)}`)
    failures++
  }

  await check("bash foreground", async () => {
    const result = await tool("bash").execute({ command: "printf foreground-ok" }, context)
    requireOk(result)
    if (!text(result).includes("foreground-ok")) throw new Error("foreground output was not returned")
  })

  await check("bash auto-yield", async () => {
    const result = await tool("bash").execute(
      { command: "sleep 12; printf yield-done" },
      { ...context, toolUseId: "linux-runtime-verification-auto-yield" },
    )
    requireOk(result)
    const body = text(result)
    if (!body.includes("transferred to managed process")) throw new Error(`foreground command did not auto-yield: ${body.replaceAll("\n", " ")}`)
    const yieldedId = body.match(/managed process ([^.\s]+)/)?.[1]
    if (!yieldedId) throw new Error("auto-yield result did not contain a managed process ID")
    // The yielded process must finish and deliver its completion notification.
    const before = notifications.length
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (notifications.slice(before).some((note) => note.includes("yield-done") || note.includes(yieldedId))) return
      await Bun.sleep(250)
    }
    throw new Error("no completion notification arrived for the yielded process")
  })

  let processId: string | undefined
  await check("bash background", async () => {
    const result = await tool("bash").execute({ command: "printf background-ok; sleep 30", background: true }, { ...context, toolUseId: "linux-runtime-verification-background" })
    requireOk(result)
    processId = text(result).match(/managed process ([^.\s]+)/)?.[1]
    if (!processId) throw new Error("background result did not contain a managed process ID")
  })

  await check("process list", async () => {
    const result = await tool("process").execute({ action: "list" }, context)
    requireOk(result)
    if (processId && !text(result).includes(processId)) throw new Error("managed process was absent from list output")
  })

  await check("process read_output", async () => {
    if (!processId) throw new Error("background launch did not provide a process ID")
    await Bun.sleep(100)
    const result = await tool("process").execute({ action: "read_output", process_id: processId }, context)
    requireOk(result)
    if (!text(result).includes("background-ok")) throw new Error("background output was not returned")
  })

  await check("process stop", async () => {
    if (!processId) throw new Error("background launch did not provide a process ID")
    requireOk(await tool("process").execute({ action: "stop", process_id: processId }, context))
  })

  await check("write", async () => {
    requireOk(await tool("write").execute({ path: "sample.txt", content: "alpha\nbeta\n" }, context))
    if (await Bun.file(join(workspace, "sample.txt")).text() !== "alpha\nbeta\n") throw new Error("write content differs")
  })

  await check("read", async () => {
    const result = await tool("read").execute({ path: "sample.txt", limit: 10 }, context)
    requireOk(result)
    if (!text(result).includes("1|alpha")) throw new Error("read did not return the first numbered line")
  })

  await check("edit", async () => {
    requireOk(await tool("edit").execute({ path: "sample.txt", old_string: "alpha", new_string: "ALPHA" }, context))
    if (await Bun.file(join(workspace, "sample.txt")).text() !== "ALPHA\nbeta\n") throw new Error("edit content differs")
  })

  await optionalNativeCheck("search", () => tool("search").execute({ pattern: "ALPHA", path: "sample.txt", output_mode: "content" }, context))
  await optionalNativeCheck("list", () => tool("list").execute({ path: ".", include: "files" }, context))
} finally {
  await background.close()
  foregroundBashHold.dispose()
  await launcher?.dispose()
}

if (notifications.length > 0) console.log(`INFO background notifications: ${notifications.length}`)
if (failures > 0) process.exit(1)
