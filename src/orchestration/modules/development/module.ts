import { fileURLToPath } from "node:url"
import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import { ownedCommandRunner } from "../../../infra/owned-command.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/module-runtime-services.js"
import type { ToolDeclaration } from "../../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../../modules.js"
import type { BenchmarkAdmissionDeps } from "./benchmark/admission.js"
import { createBenchmarkTool } from "./benchmark-tool.js"
import { cacheReportVerb } from "./cli/cache-report.js"
import { claudeSdkNoun } from "./cli/claude-sdk.js"
import { efficiencyVerb } from "./cli/efficiency.js"
import { createIosSimulatorTool } from "./ios-simulator-tool.js"
import type { RuntimeTool } from "../../agent-runtime/tools/types.js"
import { createDevelopmentIosSimulatorService, iosSimulatorService } from "./ios-simulator-service.js"
import type { ModuleProcessServices } from "../../app-service/module-service-host.js"
import { createBugReportNotice } from "./bug-report-notice.js"

function createDevelopmentService(services: ModuleProcessServices) {
  const simulator = createDevelopmentIosSimulatorService(services)
  const notice = createBugReportNotice({
    runCommand: ownedCommandRunner(services.launcher),
    notify: services.notify,
    enabled: services.enabled,
    executionCwd: services.directories.executionCwd,
  })
  return {
    ...simulator,
    start: notice.start,
    closeAdmission() { notice.closeAdmission?.(); simulator.closeAdmission?.() },
    async dispose() { await Promise.all([notice.dispose(), simulator.dispose()]) },
  }
}

interface DevelopmentRuntime {
  readonly benchmark?: BenchmarkAdmissionDeps
  readonly iosSimulator?: RuntimeTool
}

const developmentRuntime = moduleRuntimeHandle<DevelopmentRuntime>("development")

/** A benchmark spends real provider budget and runs whole persona matrices, so
 *  it belongs to the interactive chat surface alone. A candidate runner - a
 *  benchmark cell, an agent of a workflow, a subagent - is built by this same factory,
 *  and none of them receives it: a cell that could launch its own benchmark
 *  would recurse. Launching also needs the generation's launch authority,
 *  because a cell provisions its sandbox with owned commands, and the account
 *  capture, because every client of the run is admitted from one snapshot of
 *  this runner's own provider connection. */
function createBenchmarkRuntime(services: ModuleRuntimeServices): BenchmarkAdmissionDeps | undefined {
  const { launcher, background, foregroundBashHold, usageProfile, captureProviderConnection } = services
  if (!launcher || !background || !foregroundBashHold || !usageProfile || services.purpose.kind !== "interactive-chat" || !captureProviderConnection) return undefined
  return {
    userDataRoot: services.userDataRoot,
    accountHome: services.accountHome,
    definitions: services.definitions,
    availableModels: services.availableModels,
    moduleSelection: services.moduleSelection,
    captureRuntimeConfig: services.captureRuntimeConfig,
    runOwnedCommand: ownedCommandRunner(launcher),
    profileId: usageProfile.profileId,
    authorityIncarnation: usageProfile.authorityIncarnation,
    launcher,
    background,
    foregroundBashHold,
    shell: background.shell,
    captureProviderConnection,
  }
}

function createDevelopmentRuntime(services: ModuleRuntimeServices): DevelopmentRuntime | undefined {
  const benchmark = createBenchmarkRuntime(services)
  const simulator = services.modules.get(iosSimulatorService)
  const iosSimulator = simulator
    ? createIosSimulatorTool({ execute: simulator.execute })
    : undefined
  return benchmark || iosSimulator ? { ...(benchmark ? { benchmark } : {}), ...(iosSimulator ? { iosSimulator } : {}) } : undefined
}

const benchmark = {
  category: "opt-in",
  action: "benchmark_run",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 15,
  registrations: {
    benchmark: {
      capabilities: [],
      create: ({ modules }) => {
        const runtime = modules.get(developmentRuntime)?.benchmark
        return runtime ? { tool: createBenchmarkTool(runtime) } : { reason: "no benchmark runtime available" }
      },
    },
  },
} as const satisfies ToolDeclaration<never>

const iosSimulator = {
  category: "ambient",
  action: "shell_exec",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: true,
  personaOrder: 12,
  registryOrder: 20,
  registrations: {
    ios_simulator: {
      capabilities: [],
      create: ({ modules }) => {
        const tool = modules.get(developmentRuntime)?.iosSimulator
        return tool ? { tool } : { reason: "no owned command runner available" }
      },
    },
  },
} as const satisfies ToolDeclaration<never>

/** Flywheel's own development tooling as one module: benchmark and simulator
 *  tools, development skills, repository-specific agent methods, the
 *  `/bug-report-triage` command that starts one of them, and operator verbs,
 *  among them the Agent SDK provider's benchmark setup and live scenarios. It
 *  is absent from every release: only the source entry installs it
 *  (`scripts/source-cli.ts` through `development-modules.ts`), so a release
 *  contains none of these files, and one source setting turns it off. */
export const developmentModule = {
  id: "development",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: iosSimulatorService, create: createDevelopmentService },
  runtime: { handle: developmentRuntime, create: createDevelopmentRuntime },
  contributions: [
    { domain: "modelRoles", id: "development", value: ["benchmark-judge"] },
    { domain: "tools", id: "benchmark", value: { kind: "tool", name: "benchmark", declaration: benchmark } },
    { domain: "tools", id: "ios_simulator", value: { kind: "tool", name: "ios_simulator", declaration: iosSimulator } },
    { domain: "definitions", id: "development", value: { kind: "bundle", root: fileURLToPath(new URL("definitions", import.meta.url)) } },
    { domain: "settings", id: "development", value: { control: "binary", group: "Tools", label: "Development tools", description: "Flywheel's own benchmark, simulator, and report tooling" } },
    { domain: "commands", id: "bug-report-triage", value: {
      id: "bug-report-triage",
      title: "Bug report triage",
      description: "Triage the open reports of the private bug report repository",
      aliases: [],
      execute: async (host) => host.session
        ? host.session.startMethod({ skill: "bug-report-triage", label: "/bug-report-triage" })
        : { kind: "warning", message: "Bug report triage requires an active chat session." },
    } },
    {
      domain: "cli",
      id: "dev",
      value: {
        usage: "Usage: flywheel dev <efficiency|cache-report> [args]",
        verbs: { efficiency: efficiencyVerb, "cache-report": cacheReportVerb },
      },
    },
    { domain: "cli", id: "claude-sdk", value: claudeSdkNoun },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
